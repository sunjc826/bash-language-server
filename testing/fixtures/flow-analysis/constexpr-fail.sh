#!/bin/bash
# Test that a non-zero exit yields no value

# bash-ide constexpr
fail() {
  echo "should be discarded"
  return 1
}

VALUE=$(fail)
