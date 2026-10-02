import type { PushPreview } from './git/types';
import type { KivoSurface } from './viewLayout';

export interface PendingPushReview {
  id: number;
  surface: KivoSurface;
  root: string;
  preview: PushPreview;
  branch?: string;
  afterCommit: boolean;
  rejection?: string;
}

/** Keep the reviewed Git refs on the host; the webview only returns a one-use ID. */
export class PushReviewSession {
  private nextId = 0;
  current?: PendingPushReview;

  open(review: Omit<PendingPushReview, 'id'>): PendingPushReview {
    this.current = { ...review, id: ++this.nextId };
    return this.current;
  }

  take(id: number, surface: KivoSurface, root: string): PendingPushReview | undefined {
    const review = this.current;
    if (!review || review.id !== id || review.surface !== surface || review.root !== root) return;
    this.current = undefined;
    return review;
  }

  allowsCommit(id: number, surface: KivoSurface, root: string, hash: string): boolean {
    const review = this.current;
    return Boolean(review && review.id === id && review.surface === surface && review.root === root &&
      review.preview.commits.some((commit) => commit.hash === hash));
  }

  clear(): void { this.current = undefined; }
}
