"use client";

import { SegmentError, type SegmentErrorProps } from "@/components/feedback/SegmentError";

export default function RootError(props: SegmentErrorProps) {
  return <SegmentError {...props} segment="root" />;
}
