"use client";

import { SegmentError, type SegmentErrorProps } from "@/components/feedback/SegmentError";

export default function PublicError(props: SegmentErrorProps) {
  return <SegmentError {...props} segment="public" />;
}
