(module
  (import "broker" "read_record" (func $read (param i32) (result i32)))
  (func (export "run") (param i32) (result i32)
    local.get 0 call $read))
