(module
  (import "broker" "emit" (func $emit (param i32 i32)))
  (memory (export "memory") 1)
  (func (export "run") (param i32) i32.const 0 local.get 0 call $emit)
  (func (export "cumulative")
    i32.const 0 i32.const 600 call $emit
    i32.const 0 i32.const 600 call $emit))
