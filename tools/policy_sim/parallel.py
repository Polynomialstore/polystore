"""Shared bounded parallel execution helpers for policy-simulator tools."""

from __future__ import annotations

import math
import os
from collections.abc import Callable, Sequence
from concurrent.futures import ProcessPoolExecutor
from typing import TypeVar


T = TypeVar("T")
R = TypeVar("R")

AUTO_JOB_CAP = 8


def resolve_jobs(requested: int, task_count: int) -> int:
    """Resolve a requested worker count into a safe bounded worker count.

    A requested value of 0 or less means "auto": use available CPUs, bounded by
    AUTO_JOB_CAP and the number of tasks. Positive values are still capped by
    task count so small suites do not create idle worker processes.
    """

    if task_count <= 1:
        return 1
    if requested > 0:
        return min(requested, task_count)
    cpu_count = os.cpu_count() or 1
    return max(1, min(task_count, cpu_count, AUTO_JOB_CAP))


def resolve_chunksize(task_count: int, jobs: int) -> int:
    """Pick a conservative chunksize for ProcessPoolExecutor.map.

    Scenario cases are usually heavier than the scheduling overhead, so this
    keeps small suites balanced while avoiding per-task IPC overhead for large
    sweep matrices.
    """

    if task_count <= 1 or jobs <= 1:
        return 1
    return max(1, min(32, math.ceil(task_count / (jobs * 4))))


def map_parallel(function: Callable[[T], R], tasks: Sequence[T], requested_jobs: int) -> list[R]:
    jobs = resolve_jobs(requested_jobs, len(tasks))
    if jobs == 1:
        return [function(task) for task in tasks]

    with ProcessPoolExecutor(max_workers=jobs) as executor:
        return list(executor.map(function, tasks, chunksize=resolve_chunksize(len(tasks), jobs)))
