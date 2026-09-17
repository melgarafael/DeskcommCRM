(module
  (import "broker" "hang" (func $hang))
  (func (export "run") call $hang))
