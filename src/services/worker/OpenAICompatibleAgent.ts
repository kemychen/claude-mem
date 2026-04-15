/**
 * OpenAICompatibleAgent: Generic agent for any OpenAI-compatible API endpoint.
 *
 * Supports MiniMax, DeepSeek, Moonshot, Qwen, and any provider that implements
 * the OpenAI chat/completions API contract.
 *
 * Configuration via claude-mem settings:
 *   CLAUDE_MEM_PROVIDER       = "custom"
 *   CLAUDE_MEM_CUSTOM_BASE_URL  = "https://api.minimax.io/v1/chat/completions"
 *   CLAUDE_MEM_CUSTOM_API_KEY   = "sk-..."
 *   CLAUDE_MEM_CUSTOM_MODEL     = "MiniMax-M2.7"
 *   CLAUDE_MEM_CUSTOM_LABEL     = "MiniMax"  (optional, for logs)
 *
 * Responsibility:
 * - Call OpenAI-compatible REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini/OpenRouter)
 * - Sync to database and Chroma
 * - Support any OpenAI chat/completions endpoint
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  shouldFallbackToClaude,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAICompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

/**
 * Configuration for an OpenAI-compatible provider instance.
 * Can be constructed from settings (custom provider) or hardcoded (preset).
 */
export interface OpenAICompatibleConfig {
  /** Display label for logs (e.g. "MiniMax", "DeepSeek") */
  label: string;
  /** Full URL to the chat/completions endpoint */
  baseUrl: string;
  /** API key */
  apiKey: string;
  /** Model identifier (e.g. "MiniMax-M2.7", "deepseek-chat") */
  model: string;
  /** Optional extra headers (e.g. for provider-specific auth) */
  extraHeaders?: Record<string, string>;
  /** Max context messages (default 20) */
  maxContextMessages?: number;
  /** Max estimated tokens (default 100000) */
  maxEstimatedTokens?: number;
}

export class OpenAICompatibleAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    const config = getCustomProviderConfig();
    const { label, apiKey, model, baseUrl } = config;

    logger.info('SESSION', `[${label}] Starting session`, {
      sessionDbId: session.sessionDbId,
      project: session.project,
      model,
      baseUrl: baseUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@'),  // mask credentials in URL
      hasApiKey: !!apiKey,
      maxContextMessages: config.maxContextMessages,
      maxEstimatedTokens: config.maxEstimatedTokens,
    });

    if (!apiKey) {
      throw new Error(`Custom provider API key not configured. Set CLAUDE_MEM_CUSTOM_API_KEY in settings.`);
    }
    if (!baseUrl) {
      throw new Error(`Custom provider base URL not configured. Set CLAUDE_MEM_CUSTOM_BASE_URL in settings.`);
    }

    try {
      // Generate synthetic memorySessionId
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `custom-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=${label}`);
      }

      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      session.conversationHistory.push({ role: 'user', content: initPrompt });
      logger.debug('SESSION', `[${label}] Sending init prompt`, {
        sessionDbId: session.sessionDbId,
        promptNumber: session.lastPromptNumber,
        historyLength: session.conversationHistory.length,
      });
      const initResponse = await this.queryMultiTurn(session.conversationHistory, config);

      if (initResponse.content) {
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        await processAgentResponse(
          initResponse.content, session, this.dbManager, this.sessionManager,
          worker, tokensUsed, null, label, undefined, model
        );
      } else {
        logger.error('SDK', `Empty ${label} init response`, { sessionId: session.sessionDbId, model });
      }

      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        session.processingMessageIds.push(message._persistentId);
        if (message.cwd) lastCwd = message.cwd;
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          logger.debug('SESSION', `[${label}] Processing observation`, {
            sessionDbId: session.sessionDbId,
            toolName: message.tool_name,
            promptNumber: message.prompt_number,
          });
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }
          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured.');
          }

          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (obsResponse.content) {
            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            obsResponse.content || '', session, this.dbManager, this.sessionManager,
            worker, tokensUsed, originalTimestamp, label, lastCwd, model
          );
        } else if (message.type === 'summarize') {
          logger.debug('SESSION', `[${label}] Processing summarize`, {
            sessionDbId: session.sessionDbId,
            memorySessionId: session.memorySessionId,
          });
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured.');
          }

          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryMultiTurn(session.conversationHistory, config);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          await processAgentResponse(
            summaryResponse.content || '', session, this.dbManager, this.sessionManager,
            worker, tokensUsed, originalTimestamp, label, lastCwd, model
          );
        }
      }

      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', `${label} agent completed`, {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', `${label} agent aborted`, { sessionId: session.sessionDbId });
        throw error;
      }

      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', `${label} API failed, falling back to Claude SDK`, {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
        });
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', `${label} agent error`, { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  private truncateHistory(history: ConversationMessage[], config: OpenAICompatibleConfig): ConversationMessage[] {
    const MAX_CONTEXT_MESSAGES = config.maxContextMessages ?? DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = config.maxEstimatedTokens ?? DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) return history;
    }

    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);
      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          estimatedTokens: tokenCount,
        });
        break;
      }
      truncated.unshift(msg);
      tokenCount += msgTokens;
    }

    return truncated;
  }

  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  private async queryMultiTurn(
    history: ConversationMessage[],
    config: OpenAICompatibleConfig,
    retryCount = 0,
  ): Promise<{ content: string; tokensUsed?: number }> {
    const { label, baseUrl, apiKey, model, extraHeaders } = config;
    const truncatedHistory = this.truncateHistory(history, config);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);

    logger.debug('SDK', `Querying ${label} multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars: truncatedHistory.reduce((sum, m) => sum + m.content.length, 0),
    });

    const requestStart = Date.now();

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const elapsedMs = Date.now() - requestStart;
      // Retry on 5xx (server-side transient errors) up to 3 times with backoff
      const isTransient = response.status >= 500 && response.status < 600;
      const maxRetries = 3;
      if (isTransient && retryCount < maxRetries) {
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 8000);
        logger.warn('SDK', `[${label}] API ${response.status} error, retrying in ${backoffMs}ms`, {
          status: response.status,
          model,
          elapsedMs,
          attempt: retryCount + 1,
          maxRetries,
          errorPreview: errorText.slice(0, 100),
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.queryMultiTurn(history, config, retryCount + 1);
      }
      logger.error('SDK', `[${label}] API HTTP error`, {
        status: response.status,
        model,
        elapsedMs,
        errorPreview: errorText.slice(0, 200),
      });
      throw new Error(`${label} API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAICompletionResponse;

    if (data.error) {
      throw new Error(`${label} API error: ${data.error.code || data.error.type} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', `Empty response from ${label}`);
      return { content: '' };
    }

    const content = data.choices[0].message.content;

    // Strip <think>...</think> blocks that some models (e.g. MiniMax) include
    // before their actual response — the parser only looks for XML tags like
    // <observation> and <summary>, so thinking blocks would cause false "non-XML"
    // discards.
    const strippedContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const tokensUsed = data.usage?.total_tokens;

    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      logger.info('SDK', `[${label}] API usage`, {
        model, inputTokens, outputTokens, totalTokens: tokensUsed,
        messagesInContext: truncatedHistory.length,
        elapsedMs: Date.now() - requestStart,
      });

      if (tokensUsed > 50000) {
        logger.warn('SDK', `High token usage on ${label}`, { totalTokens: tokensUsed });
      }
    }

    return { content: strippedContent, tokensUsed };
  }
}

// ============================================================================
// Configuration helpers
// ============================================================================

/**
 * Load custom provider configuration from settings.
 * Reads CLAUDE_MEM_CUSTOM_* keys from the settings file.
 */
export function getCustomProviderConfig(): OpenAICompatibleConfig {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

  const apiKey = settings.CLAUDE_MEM_CUSTOM_API_KEY
    || getCredential('CLAUDE_MEM_CUSTOM_API_KEY')
    || '';
  const baseUrl = settings.CLAUDE_MEM_CUSTOM_BASE_URL || '';
  const model = settings.CLAUDE_MEM_CUSTOM_MODEL || 'gpt-4o-mini';
  const label = settings.CLAUDE_MEM_CUSTOM_LABEL || 'Custom';

  const maxContextMessages = parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
  const maxEstimatedTokens = parseInt(settings.CLAUDE_MEM_CUSTOM_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

  logger.debug('SDK', `[CustomProvider] Config loaded`, {
    label,
    baseUrl: baseUrl ? baseUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@') : '(not set)',
    model,
    hasApiKey: !!apiKey,
    maxContextMessages,
    maxEstimatedTokens,
  });

  return { label, baseUrl, apiKey, model, maxContextMessages, maxEstimatedTokens };
}

/**
 * Check if the custom provider has an API key and base URL configured.
 */
export function isCustomProviderAvailable(): boolean {
  const config = getCustomProviderConfig();
  return !!(config.apiKey && config.baseUrl);
}

/**
 * Check if "custom" is the selected provider.
 */
export function isCustomProviderSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'custom';
}
