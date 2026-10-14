"""Deploy / interaction scripts must not call an undecided or disagreed transaction a success."""

import pytest

from scripts.common import TxNotSuccessful, assess_receipt

GOOD = {"statusName": "ACCEPTED", "txExecutionResultName": "FINISHED_WITH_RETURN", "resultName": "MAJORITY_AGREE"}


def test_accepted_and_finalized_with_a_return_are_successes():
    assert assess_receipt(GOOD)["status"] == "ACCEPTED"
    assert assess_receipt({**GOOD, "statusName": "FINALIZED"})["status"] == "FINALIZED"


def test_snake_case_receipts_and_py_sdk_lifecycle_status_are_read():
    py = {
        "tx_execution_result_name": "FINISHED_WITH_RETURN",
        "result_name": "MAJORITY_AGREE",
        "consensus_history": {"latestDecision": {"status": "ACCEPTED"}},
    }
    assert assess_receipt(py)["consensus"] == "MAJORITY_AGREE"


@pytest.mark.parametrize("patch", [
    {"statusName": "UNDETERMINED"},  # the audit's receipt shape
    {"statusName": "UNDETERMINED", "resultName": "MAJORITY_DISAGREE"},
    {"statusName": "PENDING"},
    {"resultName": "MAJORITY_DISAGREE"},
    {"txExecutionResultName": "FINISHED_WITH_ERROR"},
    {"txExecutionResultName": None},
    {"statusName": None},
])
def test_everything_else_raises(patch):
    with pytest.raises(TxNotSuccessful):
        assess_receipt({**GOOD, **patch})


def test_an_empty_receipt_proves_nothing():
    with pytest.raises(TxNotSuccessful):
        assess_receipt({})
    with pytest.raises(TxNotSuccessful):
        assess_receipt({}, {})


def test_status_can_come_from_the_decoded_transaction():
    receipt = {"txExecutionResultName": "FINISHED_WITH_RETURN", "resultName": "MAJORITY_AGREE"}
    assert assess_receipt(receipt, {"statusName": "FINALIZED"})["status"] == "FINALIZED"
    with pytest.raises(TxNotSuccessful):
        assess_receipt(receipt, {"statusName": "UNDETERMINED"})
