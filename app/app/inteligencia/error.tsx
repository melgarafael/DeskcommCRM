"use client";

import { SegmentError } from "@/components/feedback/SegmentError";

export default function InteligenciaError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentError {...props} segment="inteligencia" />;
}
