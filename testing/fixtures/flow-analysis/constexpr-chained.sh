#!/bin/bash
# Test two marked functions where one calls the other

# bash-ide constexpr
double() {
  echo $(( $1 * 2 ))
}

# bash-ide constexpr
quad() {
  local d
  d=$(double "$1")
  echo $(( d * 2 ))
}

VALUE=$(quad 5)
