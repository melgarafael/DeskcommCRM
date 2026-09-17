(module
  (memory (export "memory") 1)
  (func (export "run") (result i32) i32.const 2 memory.grow))
