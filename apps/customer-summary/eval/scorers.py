"""
Custom scorers for customer-summary evaluation.

LLM-judged scorers use MLflow's built-in pre-made metrics (answer_correctness,
faithfulness, relevance) backed by Azure OpenAI (gpt-4o-mini). Results appear
natively in MLflow's evaluation UI.

Deterministic grounding scorer verifies factual claims against source fixture data.

Modes:
  - "full": All scorers (3 built-in LLM + 1 deterministic). Requires Azure OpenAI.
  - "ci":   Deterministic grounding scorer only. No LLM needed.

Required env vars for "full" mode (auto-bridged from AZURE_OPENAI_* if set):
  OPENAI_API_TYPE=azure
  OPENAI_API_BASE=<azure endpoint>
  OPENAI_API_KEY=<key>
  OPENAI_API_VERSION=<version>
  OPENAI_DEPLOYMENT_NAME=<deployment>
"""

import json as _json
import os
import re
import sys
from pathlib import Path as _Path
from typing import Any, Optional


LLM_SCORER_NAMES = ["answer_correctness", "faithfulness", "relevance"]
DETERMINISTIC_SCORER_NAMES = ["grounding"]
SCORER_NAMES = LLM_SCORER_NAMES + DETERMINISTIC_SCORER_NAMES


# --- Azure OpenAI env bridge ---

def _bridge_azure_env() -> None:
    """Map AZURE_OPENAI_* env vars to the OPENAI_* vars MLflow expects for Azure."""
    if os.environ.get("OPENAI_API_TYPE") == "azure":
        return  # already configured

    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT")
    key = os.environ.get("AZURE_OPENAI_API_KEY")
    deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT")
    version = os.environ.get("AZURE_OPENAI_API_VERSION", "2025-04-01-preview")

    if endpoint and key and deployment:
        os.environ.setdefault("OPENAI_API_TYPE", "azure")
        os.environ.setdefault("OPENAI_API_BASE", f"{endpoint.rstrip('/')}")
        os.environ.setdefault("OPENAI_API_KEY", key)
        os.environ.setdefault("OPENAI_API_VERSION", version)
        os.environ.setdefault("OPENAI_DEPLOYMENT_NAME", deployment)


# --- LLM-judged metrics (MLflow built-ins) ---

def _build_llm_metrics() -> list:
    """Create MLflow's built-in genai metrics for LLM-judged evaluation."""
    from mlflow.metrics.genai import answer_correctness, faithfulness, relevance

    deployment = os.environ.get("OPENAI_DEPLOYMENT_NAME", "gpt-4o-mini")
    model_uri = f"openai:/{deployment}"

    return [
        answer_correctness(model=model_uri),
        faithfulness(model=model_uri),
        relevance(model=model_uri),
    ]


# --- Deterministic grounding scorer ---


def _load_fixture(customer_id: str) -> Optional[dict]:
    """Load source fixture for a customer ID."""
    fixtures_dir = _Path(__file__).parent.parent / "fixtures" / "customers"
    fixture_path = fixtures_dir / f"{customer_id}.json"
    if not fixture_path.exists():
        return None
    return _json.loads(fixture_path.read_text())


def _extract_all_messages(fixture: dict) -> list[str]:
    """Extract all message content strings from a fixture."""
    messages = []
    for conv in fixture.get("conversations", []):
        for msg in conv.get("messages", []):
            messages.append(msg.get("content", ""))
    return messages


def _check_conversation_count(summary: str, fixture: dict) -> tuple[bool, str]:
    """Check if any conversation count mentioned in the summary matches reality."""
    actual_count = len(fixture.get("conversations", []))
    count_patterns = re.findall(r"(\d+)\s+conversation", summary.lower())
    if not count_patterns:
        return True, "No conversation count claim found"
    for claimed in count_patterns:
        if int(claimed) != actual_count:
            return False, f"Claims {claimed} conversations but source has {actual_count}"
    return True, f"Conversation count verified: {actual_count}"


def _check_customer_name(summary: str, fixture: dict) -> tuple[bool, str]:
    """Check if the customer name in the summary matches the fixture."""
    actual_name = fixture.get("name", "")
    if not actual_name:
        return True, "No name in fixture to verify"
    first_name = actual_name.split()[0]
    if first_name.lower() in summary.lower():
        return True, f"Customer name '{first_name}' found in summary"
    return True, "Customer name not mentioned (acceptable)"


def _check_topic_grounding(summary: str, fixture: dict) -> tuple[float, str]:
    """Check that topics mentioned in the summary appear in source conversations."""
    all_text = " ".join(_extract_all_messages(fixture)).lower()

    topic_keywords = {
        "billing": ["invoice", "payment", "charge", "refund", "bill", "price", "cost", "subscription", "fee", "billing"],
        "technical": ["error", "bug", "crash", "slow", "install", "update", "login", "password", "api", "integration"],
        "shipping": ["shipping", "delivery", "tracking", "package", "order", "return", "address"],
        "outage": ["outage", "down", "downtime", "unavailable", "service interruption"],
        "onboarding": ["onboarding", "setup", "getting started", "configuration"],
        "compliance": ["compliance", "regulation", "audit", "gdpr", "security"],
    }

    summary_lower = summary.lower()
    claimed_topics = []
    grounded_topics = []

    for topic, keywords in topic_keywords.items():
        if any(kw in summary_lower for kw in keywords) or topic in summary_lower:
            claimed_topics.append(topic)
            if any(kw in all_text for kw in keywords):
                grounded_topics.append(topic)

    if not claimed_topics:
        return 1.0, "No specific topics claimed"

    ratio = len(grounded_topics) / len(claimed_topics)
    ungrounded = set(claimed_topics) - set(grounded_topics)
    if ungrounded:
        return ratio, f"Ungrounded topics: {', '.join(ungrounded)}"
    return ratio, f"All {len(claimed_topics)} claimed topics grounded in source data"


def _check_sentiment_consistency(summary: str, fixture: dict) -> tuple[bool, str]:
    """Check if stated sentiment direction is consistent with source message tone."""
    positive_kw = ["thank", "great", "excellent", "awesome", "good", "love", "happy",
                   "pleased", "wonderful", "fantastic", "perfect", "appreciate", "satisfied"]
    negative_kw = ["terrible", "awful", "bad", "worst", "hate", "angry", "frustrated",
                   "disappointed", "unacceptable", "horrible", "poor", "annoying",
                   "broken", "failure", "useless", "complaint"]

    all_text = " ".join(_extract_all_messages(fixture)).lower()
    pos_count = sum(1 for kw in positive_kw if kw in all_text)
    neg_count = sum(1 for kw in negative_kw if kw in all_text)

    summary_lower = summary.lower()
    claims_positive = any(w in summary_lower for w in ["positive sentiment", "satisfied", "happy customer", "generally positive"])
    claims_negative = any(w in summary_lower for w in ["negative sentiment", "dissatisfied", "frustrated", "unhappy", "at risk", "churn"])

    if claims_positive and neg_count > pos_count * 2 and neg_count >= 3:
        return False, f"Claims positive but source has {neg_count} negative vs {pos_count} positive indicators"
    if claims_negative and pos_count > neg_count * 2 and pos_count >= 3:
        return False, f"Claims negative but source has {pos_count} positive vs {neg_count} negative indicators"
    return True, "Sentiment direction consistent with source"


def score_grounding(inputs: dict, outputs: dict, expectations: dict) -> dict[str, Any]:
    """Deterministic grounding scorer -- verifies factual claims against source data."""
    customer_id = inputs.get("customer_id", "")
    summary_text = outputs.get("summary", str(outputs))

    fixture = _load_fixture(customer_id)
    if fixture is None:
        return {"score": 3, "justification": f"Could not load fixture for {customer_id} -- skipping grounding check"}

    checks: list[tuple[str, bool, str]] = []
    penalties = 0.0

    count_ok, count_msg = _check_conversation_count(summary_text, fixture)
    checks.append(("conversation_count", count_ok, count_msg))
    if not count_ok:
        penalties += 1.5

    name_ok, name_msg = _check_customer_name(summary_text, fixture)
    checks.append(("customer_name", name_ok, name_msg))
    if not name_ok:
        penalties += 1.0

    topic_ratio, topic_msg = _check_topic_grounding(summary_text, fixture)
    topic_ok = topic_ratio >= 0.8
    checks.append(("topic_grounding", topic_ok, topic_msg))
    if not topic_ok:
        penalties += (1.0 - topic_ratio) * 2.0

    sent_ok, sent_msg = _check_sentiment_consistency(summary_text, fixture)
    checks.append(("sentiment_consistency", sent_ok, sent_msg))
    if not sent_ok:
        penalties += 1.5

    raw_score = max(1, min(5, 5.0 - penalties))
    score = round(raw_score)

    justification_lines = [f"- {name}: {'PASS' if ok else 'FAIL'} -- {msg}" for name, ok, msg in checks]
    justification = f"Grounding checks ({len([c for c in checks if c[1]])}/{len(checks)} passed):\n" + "\n".join(justification_lines)

    return {"score": score, "justification": justification}


# --- Fixture validation ---

def validate_fixtures(customer_ids: list[str]) -> list[str]:
    """Check that fixture files exist for all eval case customer IDs."""
    warnings = []
    fixtures_dir = _Path(__file__).parent.parent / "fixtures" / "customers"
    for cid in customer_ids:
        fixture_path = fixtures_dir / f"{cid}.json"
        if not fixture_path.exists():
            warnings.append(f"Missing fixture file for {cid}: {fixture_path}")
    return warnings


# --- Scorer registry ---

def get_scorers(mode: str = "full") -> list:
    """Return scorers for mlflow.evaluate().

    Returns EvaluationMetric objects compatible with the `extra_metrics` parameter
    of mlflow.evaluate(). Results appear in MLflow's evaluation UI natively.

    For "full" mode: MLflow genai metrics (LLM-judged via Azure OpenAI) + grounding.
    For "ci" mode: Deterministic grounding scorer only.

    Args:
        mode: "full" for all scorers (requires Azure OpenAI), "ci" for deterministic only.
    """
    _bridge_azure_env()

    scorers = []

    if mode != "ci":
        # LLM-judged scorers via MLflow's built-in make_genai_metric
        scorers.extend(_build_llm_metrics())

    # Deterministic grounding scorer wrapped as EvaluationMetric
    scorers.append(_build_grounding_metric())

    return scorers


def _build_grounding_metric():
    """Wrap the deterministic grounding scorer as an MLflow EvaluationMetric."""
    from mlflow.metrics import make_metric, MetricValue

    def eval_fn(predictions, targets, metrics, customer_id):
        """Compute grounding score for each row."""
        scores = []
        justifications = []

        for i in range(len(predictions)):
            cid = customer_id.iloc[i] if hasattr(customer_id, "iloc") else str(customer_id[i])
            pred = predictions.iloc[i] if hasattr(predictions, "iloc") else predictions[i]
            ref = targets.iloc[i] if hasattr(targets, "iloc") else targets[i]
            result = score_grounding(
                inputs={"customer_id": cid},
                outputs={"summary": pred},
                expectations={"reference_summary": ref},
            )
            scores.append(result["score"])
            justifications.append(result["justification"])

        return MetricValue(
            scores=scores,
            justifications=justifications,
            aggregate_results={"mean": sum(scores) / len(scores) if scores else 0.0},
        )

    return make_metric(
        eval_fn=eval_fn,
        greater_is_better=True,
        name="grounding",
    )
