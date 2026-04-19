import os
import pytest
from pathlib import Path

# Use a test-specific database
os.environ["PDFER_TEST"] = "1"

FIXTURES_DIR = Path(__file__).parent / "fixtures"
REFERENCE_PDF = FIXTURES_DIR / "reference.pdf"


@pytest.fixture
def reference_pdf():
    assert REFERENCE_PDF.exists(), f"Reference PDF not found at {REFERENCE_PDF}"
    return REFERENCE_PDF
