/**
 * Session Event Broadcaster
 *
 * Provides semantic broadcast methods for session lifecycle events.
 * Consolidates SSE broadcasting and processing status updates.
 */

import { SSEBroadcaster } from '../SSEBroadcaster.js';
import type { WorkerService } from '../../worker-service.js';
import { logger } from '../../../utils/logger.js';

export class SessionEventBroadcaster {
  constructor(
    private sseBroadcaster: SSEBroadcaster,
    private workerService: WorkerService
  ) {}

  /**
   * Broadcast new user prompt arrival
   * Starts activity indicator to show work is beginning
   */
  broadcastNewPrompt(prompt: {
    id: number;
    content_session_id: string;
    project: string;
    platform_source: string;
    prompt_number: number;
    prompt_text: string;
    created_at_epoch: number;
  }): void {
    // Broadcast prompt details
    this.sseBroadcaster.broadcast({
      type: 'new_prompt',
      prompt
    });

    // Update processing status based on queue depth
    this.workerService.broadcastProcessingStatus();
  }

  /**
   * Broadcast session initialization
   */
  broadcastSessionStarted(sessionDbId: number, project: string): void {
    this.sseBroadcaster.broadcast({
      type: 'session_started',
      sessionDbId,
      project
    });

    // Update processing status
    this.workerService.broadcastProcessingStatus();
  }

  /**
   * Broadcast observation queued
   * Updates processing status to reflect new queue depth
   */
  broadcastObservationQueued(sessionDbId: number): void {
    try {
      this.sseBroadcaster?.broadcast?.({
        type: 'observation_queued',
        sessionDbId
      } as any);
    } catch (error) {
      logger.warn('SSE', 'broadcastObservationQueued degraded to status-only mode', { sessionDbId }, error as Error);
    }

    try {
      (this.workerService as any)?.broadcastProcessingStatus?.();
    } catch (error) {
      logger.warn('SSE', 'broadcastProcessingStatus failed during observation queue broadcast', { sessionDbId }, error as Error);
    }
  }

  /**
   * Broadcast session completion
   * Updates processing status to reflect session removal
   */
  broadcastSessionCompleted(sessionDbId: number): void {
    try {
      this.sseBroadcaster?.broadcast?.({
        type: 'session_completed',
        timestamp: Date.now(),
        sessionDbId
      } as any);
    } catch (error) {
      logger.warn('SSE', 'broadcastSessionCompleted degraded to status-only mode', { sessionDbId }, error as Error);
    }

    try {
      (this.workerService as any)?.broadcastProcessingStatus?.();
    } catch (error) {
      logger.warn('SSE', 'broadcastProcessingStatus failed during session completed broadcast', { sessionDbId }, error as Error);
    }
  }

  /**
   * Broadcast summarize request queued
   * Updates processing status to reflect new queue depth
   */
  broadcastSummarizeQueued(): void {
    try {
      (this.workerService as any)?.broadcastProcessingStatus?.();
    } catch (error) {
      logger.warn('SSE', 'broadcastProcessingStatus failed during summarize queue broadcast', {}, error as Error);
    }
  }
}
