#!/usr/bin/env python3
"""Solve a hourkeep challenge from `hourkeep confirm <id> --json` output on stdin.

Used by the Docker end-to-end tests to act like the person at the keyboard: it reads only
what the challenge shows (the text to retype, the problems, the question), never a secret.
"""
import json
import re
import sys

challenge = json.load(sys.stdin)["data"]["challenge"]["data"]
kind = challenge["kind"]
if kind == "typing":
    print(challenge["text"])
elif kind == "arithmetic":
    answers = []
    for problem in challenge["problems"]:
        expr = problem.replace("\u00d7", "*").replace("\u2212", "-")
        if not re.fullmatch(r"[0-9+\-*() ]+", expr):
            sys.exit(f"unexpected problem: {problem!r}")
        answers.append(str(eval(expr)))  # noqa: S307 - validated above
    print(" ".join(answers))
else:
    print("I want to watch the one lecture video my professor assigned for tomorrow morning")
