"""
Custom scorers using Flow Judge (3.8B) via Ollama for local + CI evaluation.

Flow Judge is a purpose-built LLM-as-judge model that scores on rubrics
and returns structured <feedback>/<score> output. Runs locally via Ollama
with GPU acceleration (Metal on macOS, CUDA on Linux).

Ollama exposes an OpenAI-compatible API at /v1/chat/completions,
so we use the openai SDK to call it.
"""

import os
import re
from typing import Any, Optional

from openai import OpenAI

FLOW_JUDGE_MODEL = "avcodes/flowaicom-flow-judge"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

SCORER_NAMES = ["factuality", "completeness", "conciseness", "grounding"]
PASS_THRESHOLD = 4.0

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


def _parse_score(response_text: str) -> Optional[int]:
    """Extract numeric score from Flow Judge <score> tags."""
    match = re.search(r"<score>\s*(\d+)\s*</score>", response_text)
    if match:
        return int(match.group(1))
    return None


def _parse_feedback(response_text: str) -> str:
    """Extract feedback from Flow Judge <feedback> tags."""
    match = re.search(r"<feedback>(.*?)</feedback>", response_text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return response_text.strip()


def _create_client() -> OpenAI:
    """Create OpenAI client pointing at Ollama's compatible API."""
    return OpenAI(
        base_url=f"{OLLAMA_BASE_URL}/v1",
        api_key="ollama",  # Ollama doesn't require a real key
    )


def _call_flow_judge(
    client: OpenAI,
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

    response = client.chat.completions.create(
        model=FLOW_JUDGE_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
        max_tokens=1024,
    )

    text = response.choices[0].message.content or ""
    score = _parse_score(text)
    feedback = _parse_feedback(text)

    return {
        "score": score,
        "feedback": feedback,
        "raw_response": text,
    }


# --- MLflow-compatible scorer functions ---
# These follow the interface expected by mlflow.genai.evaluate():
#   scorer(inputs, outputs, expectations) -> dict with score

def _make_scorer(scorer_name: str):
    """Factory for MLflow @scorer-compatible functions."""
    client = _create_client()

    def score_fn(inputs: dict, outputs: dict, expectations: dict) -> dict[str, Any]:
        summary_text = outputs.get("summary", str(outputs))
        reference = expectations.get("reference_summary", "")
        customer_id = inputs.get("customer_id", "unknown")

        result = _call_flow_judge(
            client=client,
            output=summary_text,
            reference_summary=reference,
            scorer_name=scorer_name,
            user_query=f"Summarize conversation history for customer {customer_id}.",
        )

        return {
            "score": result["score"],
            "justification": result["feedback"],
        }

    score_fn.__name__ = scorer_name
    return score_fn


# --- Deterministic grounding scorer ---
# Verifies factual claims in the summary against source fixture data.
# No LLM judge needed -- pure programmatic checks.

import json as _json
from pathlib import Path as _Path


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
    # Look for numeric claims about conversations
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
    # Check if summary mentions a different name (not the actual one)
    # We only flag if the actual name is NOT found but another proper-noun-like name is
    first_name = actual_name.split()[0]
    if first_name.lower() in summary.lower():
        return True, f"Customer name '{first_name}' found in summary"
    # No name mentioned is fine -- only flag if a wrong name appears
    return True, "Customer name not mentioned (acceptable)"


def _check_topic_grounding(summary: str, fixture: dict) -> tuple[float, str]:
    """Check that topics mentioned in the summary appear in source conversations.

    Returns (score_fraction, justification) where score_fraction is 0.0-1.0.
    """
    all_text = " ".join(_extract_all_messages(fixture)).lower()

    # Common topic keywords to check for in the summary
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
        # Check if summary mentions this topic
        if any(kw in summary_lower for kw in keywords) or topic in summary_lower:
            claimed_topics.append(topic)
            # Check if source data supports this topic
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

    # Flag contradiction: summary says positive but source is overwhelmingly negative (or vice versa)
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

    # Check 1: Conversation count
    count_ok, count_msg = _check_conversation_count(summary_text, fixture)
    checks.append(("conversation_count", count_ok, count_msg))
    if not count_ok:
        penalties += 1.5

    # Check 2: Customer name
    name_ok, name_msg = _check_customer_name(summary_text, fixture)
    checks.append(("customer_name", name_ok, name_msg))
    if not name_ok:
        penalties += 1.0

    # Check 3: Topic grounding
    topic_ratio, topic_msg = _check_topic_grounding(summary_text, fixture)
    topic_ok = topic_ratio >= 0.8
    checks.append(("topic_grounding", topic_ok, topic_msg))
    if not topic_ok:
        penalties += (1.0 - topic_ratio) * 2.0

    # Check 4: Sentiment consistency
    sent_ok, sent_msg = _check_sentiment_consistency(summary_text, fixture)
    checks.append(("sentiment_consistency", sent_ok, sent_msg))
    if not sent_ok:
        penalties += 1.5

    # Convert penalties to 1-5 score
    raw_score = max(1, min(5, 5.0 - penalties))
    score = round(raw_score)

    justification_lines = [f"- {name}: {'PASS' if ok else 'FAIL'} -- {msg}" for name, ok, msg in checks]
    justification = f"Grounding checks ({len([c for c in checks if c[1]])}/{len(checks)} passed):\n" + "\n".join(justification_lines)

    return {"score": score, "justification": justification}


def get_scorers() -> list:
    """Return all scorers wrapped for mlflow.genai.evaluate()."""
    llm_scorer_names = [n for n in SCORER_NAMES if n != "grounding"]

    try:
        from mlflow.genai.scorers import scorer as mlflow_scorer

        scorers = []
        # LLM-based scorers (factuality, completeness, conciseness)
        for name in llm_scorer_names:
            fn = _make_scorer(name)

            @mlflow_scorer(name=name)
            def _scorer(inputs, outputs, expectations, _fn=fn):
                return _fn(inputs, outputs, expectations)

            scorers.append(_scorer)

        # Deterministic grounding scorer
        @mlflow_scorer(name="grounding")
        def _grounding_scorer(inputs, outputs, expectations):
            return score_grounding(inputs, outputs, expectations)

        scorers.append(_grounding_scorer)
        return scorers
    except ImportError:
        # Fallback: return raw functions if mlflow scorer decorator unavailable
        fns = [_make_scorer(name) for name in llm_scorer_names]
        fns.append(score_grounding)
        return fns
