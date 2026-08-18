#!/bin/bash
# Test that the marker can appear anywhere in the contiguous doc block

# This helper doubles its argument.
# It is safe to run at analysis time.
# bash-ide constexpr
# (marker is on the third line of the block)
double() {
  echo $(( $1 * 2 ))
}

VALUE=$(double 3)
