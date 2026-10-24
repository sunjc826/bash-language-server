#!/bin/bash
# Test that unmarked functions and trailing-comment-only markers are not evaluated

unmarked() {
  echo $(( $1 * 2 ))
}

trailing() {
  echo $(( $1 * 2 ))
} # bash-ide constexpr

A=$(unmarked 21)
B=$(trailing 21)
