"use client";

import { SegmentError, type SegmentErrorProps } from "@/components/feedback/SegmentError";

export default function AppError(props: SegmentErrorProps) {
  return <SegmentError {...props} segment="app" />;
}
