import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

ProbeScenario = Literal["fixed_interruption", "candidate_response"]
ActivationState = Literal["warm", "cold"]
BrowserFloor = Literal["chromium-desktop", "ios-safari"]


@dataclass(frozen=True)
class Candidate:
    stt: str
    llm: str
    tts: str
    voice: str


@dataclass(frozen=True)
class ProbeJob:
    candidate_id: str
    candidate: Candidate
    nonce: str
    sample_id: str
    scenario: ProbeScenario

    @classmethod
    def from_metadata(cls, metadata: str) -> "ProbeJob":
        payload = json.loads(metadata)
        if not isinstance(payload, Mapping) or set(payload) != {
            "candidate_id",
            "candidate",
            "nonce",
            "sample_id",
            "scenario",
        }:
            raise ValueError("job metadata does not match the probe contract")
        raw_candidate = payload["candidate"]
        if not isinstance(raw_candidate, Mapping) or set(raw_candidate) != {
            "stt",
            "llm",
            "tts",
            "voice",
        }:
            raise ValueError("job metadata candidate does not match the probe contract")
        strings = {
            "candidate_id": payload["candidate_id"],
            "nonce": payload["nonce"],
            "sample_id": payload["sample_id"],
            "stt": raw_candidate["stt"],
            "llm": raw_candidate["llm"],
            "tts": raw_candidate["tts"],
            "voice": raw_candidate["voice"],
        }
        if any(not isinstance(value, str) or not value for value in strings.values()):
            raise ValueError("job metadata identifiers must be non-empty strings")
        scenario = payload["scenario"]
        if scenario == "candidate_response":
            checked_scenario: ProbeScenario = "candidate_response"
        elif scenario == "fixed_interruption":
            checked_scenario = "fixed_interruption"
        else:
            raise ValueError("job metadata scenario is invalid")
        return cls(
            candidate_id=strings["candidate_id"],
            candidate=Candidate(
                stt=strings["stt"],
                llm=strings["llm"],
                tts=strings["tts"],
                voice=strings["voice"],
            ),
            nonce=strings["nonce"],
            sample_id=strings["sample_id"],
            scenario=checked_scenario,
        )
