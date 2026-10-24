#!/bin/bash
# Test constexpr function evaluation with literal args

# bash-ide constexpr
double() {
  echo $(( $1 * 2 ))
}

VALUE=$(double 21)
