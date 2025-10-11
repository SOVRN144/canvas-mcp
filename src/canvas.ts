// src/canvas.ts
import type { AxiosInstance } from 'axios';
import logger from './logger.js';

export interface CanvasAssignment {
  id: number;
  name: string;
  description?: string;
  points_possible?: number;
  due_at?: string | null;
  unlock_at?: string | null;
  lock_at?: string | null;
  html_url?: string;
  [key: string]: unknown;
}

/**
 * Fetches a Canvas assignment by ID.
 * @param canvasClient The configured Canvas API client
 * @param courseId The Canvas course ID
 * @param assignmentId The Canvas assignment ID
 * @returns Canvas assignment data
 * @throws If the Canvas API request fails
 */
export async function getAssignment(
  canvasClient: AxiosInstance,
  courseId: number,
  assignmentId: number
): Promise<CanvasAssignment> {
  try {
    const response = await canvasClient.get<CanvasAssignment>(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}`
    );
    return response.data;
  } catch (error) {
    logger.error('Failed to get Canvas assignment', { courseId, assignmentId, error: String(error) });
    throw new Error(`Assignment ${assignmentId}: failed to retrieve from Canvas API`);
  }
}
