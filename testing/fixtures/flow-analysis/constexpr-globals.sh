#!/bin/bash
# Test constexpr evaluation with flow-resolved globals and variable args

PREFIX="hello"
N="21"

# bash-ide constexpr
prefixed() {
  echo "$PREFIX world"
}

# bash-ide constexpr
double() {
  echo $(( $1 * 2 ))
}

MSG=$(prefixed)
DOUBLED=$(double "$N")
