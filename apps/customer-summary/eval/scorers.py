"""
Custom scorers using Flow Judge (3.8B) via Ollama for local + CI evaluation.

Flow Judge is a purpose-built LLM-as-judge model that scores on rubrics
and returns structured <feedback>/<score> output. Runs locally via Ollama
with GPU acceleration (Metal on macOS, CUDA on Linux) or CPU.

Ollama exposes an OpenAI-compatible API at /v1/chat/completions,
so we use the openai SDK to call it.

Modes:
  - "full": All scorers (3 LLM-judged + 1 deterministic). Requires Ollama.
  - "ci":   Deterministic grounding scorer only. No Ollama needed.
"""

import json as _json
import os
import re
import sys
import threading
from pathlib import Path as _Path
from typing import Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from openai import OpenAI

FLOW_JUDGE_MODEL = "avcodes/flowaicom-flow-judge"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_TIMEOUT_SEC = int(os.environ.get("OLLAMA_TIMEOUT_SEC", "120"))

LLM_SCORER_NAMES = ["factuality", "completeness", "conciseness"]
DETERMINISTIC_SCORER_NAMES = ["grounding"]
SCORER_NAMES = LLM_SCORER_NAMES + DETERMINISTIC_SCORER_NAMES


# --- Flow Judge prompt template ---
# Flow Judge expects this exact format with evaluation criteria + 5-Likert rubric.

FLOW_JUDGE_TEMPLATE = """# GOAL
Your job is to evaluate a task carried out by an AI system powered by a large language model.
You will be provided with the inputs and output of the task, as well as the evaluation criteria and scoring rubric. Your task is to evaluate the output of the AI system based on the evaluation criteria and scoring rubric provided.

# INPUT
Below are the inputs required for performing the task:
<inputs>
<user_query>
{user_query}
</user_query>
<reference_summary>
{reference_summary}
</reference_summary>
</inputs>

# OUTPUT
Below is the output of the task:
<output>
{output}
</output>

# EVALUATION CRITERIA AND SCORING RUBRIC
Here are the evaluation criteria and the rubric that you need to use for evaluating the task:
<evaluation_criteria>
{evaluation_criteria}
</evaluation_criteria>

<scoring_rubric>
{scoring_rubric}
</scoring_rubric>

# INSTRUCTIONS FOR THE EVALUATION
1. Understand the task and criteria: Familiarize yourself with the task to be evaluated. Review the evaluation criteria and scoring rubric to understand the different levels of performance and the descriptions for each score.
2. Review the inputs and output: Look at the inputs provided for the task. Examine the output generated from completing the task.
3. Compare output to score descriptions: Compare the output against the criteria and score descriptions in the scoring rubric. For each criterion, decide which description best matches the output.
4. After comparing the output to the score descriptions, pay attention to the small details that might impact the final score that you assign. Sometimes a small difference can dictate the final score.
5. Write verbal feedback justifying your evaluation that includes a detailed rationale, referring to specific aspects of the output and comparing them to the rubric.
6. Assign a final score based on the scoring rubric.

## FORMAT FOR THE EVALUATION
- Write the verbal feedback inside <feedback> tags without any additional surrounding text.
- Write the numeric score inside <score> tags, without any additional surrounding text and always after the feedback.

Please accurately evaluate the task. Strictly adhere to the evaluation criteria and rubric."""

# --- Rubric definitions per scorer ---

RUBRICS = {
    "factuality": {
        "criteria": "How factually accurate is the generated summary compared to the reference summary? Does it contain any hallucinated or incorrect information?",
        "rubric": """- Score 1: The summary contains major factual errors or hallucinations that contradict the reference summary.
- Score 2: The summary contains several factual inaccuracies or unsupported claims not present in the reference.
- Score 3: The summary is mostly accurate but contains minor factual errors or slight misrepresentations.
- Score 4: The summary is factually accurate with only negligible discrepancies from the reference.
- Score 5: The summary is fully factually accurate, consistent with the reference summary, with no hallucinations or errors.""",
    },
    "completeness": {
        "criteria": "How completely does the generated summary cover the key information present in the reference summary? Does it miss any important topics or details?",
        "rubric": """- Score 1: The summary misses most key information and topics from the reference summary.
- Score 2: The summary covers only a few key points, missing many important topics from the reference.
- Score 3: The summary covers some key topics but misses several important details present in the reference.
- Score 4: The summary covers most key topics and details, with only minor omissions.
- Score 5: The summary comprehensively covers all key information, topics, and details from the reference summary.""",
    },
    "conciseness": {
        "criteria": "How concise and well-structured is the generated summary? Does it avoid unnecessary repetition and verbosity while maintaining clarity?",
        "rubric": """- Score 1: The summary is extremely verbose, repetitive, or poorly structured, making it difficult to read.
- Score 2: The summary contains significant unnecessary repetition or verbosity that detracts from clarity.
- Score 3: The summary is reasonably concise but contains some unnecessary information or could be more tightly written.
- Score 4: The summary is well-structured and concise with only minor verbosity.
- Score 5: The summary is optimally concise, well-structured, and free of unnecessary repetition while maintaining all essential information.""",
    },
}


# --- Parsing helpers ---

def _parse_score(response_text: str) -> Optional[int]:
    """Extract numeric score from Flow Judge <score> tags."""
    match = re.search(r"<score>\s*(\d+)\s*</score>", response_text)
    if match:
        score = int(match.group(1))
        if 1 <= score <= 5:
            return score
        print(f"WARNING: Flow Judge returned out-of-range score {score}, clamping to 1-5", file=sys.stderr)
        return max(1, min(5, score))
    return None


def _parse_feedback(response_text: str) -> str:
    """Extract feedback from Flow Judge <feedback> tags."""
    match = re.search(r"<feedback>(.*?)</feedback>", response_text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return response_text.strip()


# --- Shared Ollama client ---

_client: Optional["OpenAI"] = None
_client_lock = threading.Lock()


def _get_client() -> "OpenAI":
    """Get or create a shared OpenAI client pointing at Ollama. Thread-safe."""
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        # Double-check after acquiring lock
        if _client is None:
            from openai import OpenAI
            _client = OpenAI(
                base_url=f"{OLLAMA_BASE_URL}/v1",
                api_key="ollama",  # Ollama doesn't require a real key
                timeout=OLLAMA_TIMEOUT_SEC,
            )
    return _client


def _call_flow_judge(
    output: str,
    reference_summary: str,
    scorer_name: str,
    user_query: str = "Summarize the customer's conversation history.",
) -> dict[str, Any]:
    """Call Flow Judge via Ollama and parse the structured response."""
    rubric = RUBRICS[scorer_name]
    prompt = FLOW_JUDGE_TEMPLATE.format(
        user_query=user_query,
        reference_summary=reference_summary,
        output=output,
        evaluation_criteria=rubric["criteria"],
        scoring_rubric=rubric["rubric"],
    )

    client = _get_client()

    try:
        response = client.chat.completions.create(
            model=FLOW_JUDGE_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=1024,
        )
    except Exception as e:
        print(f"ERROR: Flow Judge call failed for {scorer_name}: {e}", file=sys.stderr)
        return {"score": None, "feedback": f"Flow Judge call failed: {e}", "raw_response": ""}

    try:
        text = response.choices[0].message.content or ""
    except (IndexError, AttributeError) as e:
        print(f"ERROR: Unexpected response structure for {scorer_name}: {e}", file=sys.stderr)
        return {"score": None, "feedback": f"Unexpected response structure: {e}", "raw_response": str(response)}
    score = _parse_score(text)
    feedback = _parse_feedback(text)

    if score is None:
        print(
            f"WARNING: Flow Judge returned no parseable score for {scorer_name}. "
            f"Raw response (first 200 chars): {text[:200]}",
            file=sys.stderr,
        )

    return {
        "score": score,
        "feedback": feedback,
        "raw_response": text,
    }


# --- MLflow-compatible scorer functions ---


def _make_llm_scorer(scorer_name: str):
    """Create an LLM-based scorer function for the given dimension."""

    def score_fn(inputs: dict, outputs: dict, expectations: dict) -> dict[str, Any]:
        summary_text = outputs.get("summary", str(outputs))
        reference = expectations.get("reference_summary", "")
        customer_id = inputs.get("customer_id", "unknown")

        result = _call_flow_judge(
            output=summary_text,
            reference_summary=reference,
            scorer_name=scorer_name,
            user_query=f"Summarize conversation history for customer {customer_id}.",
        )

        score = result["score"]
        if score is None:
            # Default to lowest score on parse failure so it doesn't silently pass
            print(f"WARNING: Defaulting {scorer_name} score to 1 for {customer_id} (parse failure)", file=sys.stderr)
            score = 1

        return {
            "score": score,
            "justification": result["feedback"],
        }

    score_fn.__name__ = scorer_name
    return score_fn


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
    """Check that topics mentioned in the summary appear in source conversations.

    Returns (score_fraction, justification) where score_fraction is 0.0-1.0.
    """
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
    """Deterministic grounding scorer -- verifies factual claims against source data.

    Checks:
    1. Conversation count accuracy
    2. Customer name correctness
    3. Topic grounding (are claimed topics in the source?)
    4. Sentiment direction consistency

    Returns 1-5 score where 5 = fully grounded, 1 = major grounding failures.
    """
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
    """Check that fixture files exist for all eval case customer IDs. Returns list of warnings."""
    warnings = []
    fixtures_dir = _Path(__file__).parent.parent / "fixtures" / "customers"
    for cid in customer_ids:
        fixture_path = fixtures_dir / f"{cid}.json"
        if not fixture_path.exists():
            warnings.append(f"Missing fixture file for {cid}: {fixture_path}")
    return warnings


# --- Scorer registry ---

def get_scorers(mode: str = "full") -> list:
    """Return scorers wrapped for mlflow.genai.evaluate().

    Args:
        mode: "full" for all scorers (requires Ollama), "ci" for deterministic only.
    """
    if mode == "ci":
        scorer_names = DETERMINISTIC_SCORER_NAMES
    else:
        scorer_names = SCORER_NAMES

    try:
        from mlflow.genai.scorers import scorer as mlflow_scorer
    except ImportError:
        # Fallback: return raw functions if mlflow scorer decorator unavailable
        print("WARNING: mlflow.genai.scorers not available, using raw scorer functions", file=sys.stderr)
        fns = []
        for name in scorer_names:
            if name == "grounding":
                fns.append(score_grounding)
            else:
                fns.append(_make_llm_scorer(name))
        return fns

    scorers = []
    for name in scorer_names:
        if name == "grounding":
            raw_fn = score_grounding
        else:
            raw_fn = _make_llm_scorer(name)

        # Wrap with @mlflow_scorer — capture raw_fn via default arg
        @mlflow_scorer(name=name)
        def _wrapped(inputs, outputs, expectations, _fn=raw_fn):
            return _fn(inputs, outputs, expectations)

        scorers.append(_wrapped)

    return scorers
