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

SCORER_NAMES = ["factuality", "completeness", "conciseness"]
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


def get_scorers() -> list:
    """Return Flow Judge scorers wrapped for mlflow.genai.evaluate()."""
    try:
        from mlflow.genai.scorers import scorer as mlflow_scorer

        scorers = []
        for name in SCORER_NAMES:
            fn = _make_scorer(name)

            @mlflow_scorer(name=name)
            def _scorer(inputs, outputs, expectations, _fn=fn):
                return _fn(inputs, outputs, expectations)

            scorers.append(_scorer)
        return scorers
    except ImportError:
        # Fallback: return raw functions if mlflow scorer decorator unavailable
        return [_make_scorer(name) for name in SCORER_NAMES]
