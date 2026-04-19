from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    document_count: int
    database: str


class PageSummary(BaseModel):
    id: str
    page_number: int
    width_px: int
    height_px: int
    pdf_type: str | None
    thumb_url: str | None
    text_span_count: int


class DocumentResponse(BaseModel):
    id: str
    filename: str
    page_count: int | None
    current_stage: int
    stage_status: str
    created_at: str


class DocumentDetail(BaseModel):
    id: str
    filename: str
    page_count: int | None
    current_stage: int
    stage_status: str
    created_at: str
    pages: list[PageSummary]


class DocumentListResponse(BaseModel):
    documents: list[DocumentResponse]


class ObjectResponse(BaseModel):
    id: str
    page_id: str
    label: str
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float
    confidence: float | None
    reading_order: int | None
    heading_level: int | None
    source: str
    status: str
    description: str | None = None
    description_model: str | None = None
    description_status: str = "pending"
    description_edited_by_user: int = 0
    asset_path: str | None = None


class DescribeResponse(BaseModel):
    document_id: str
    total_described: int
    failed: int
    skipped: int


class DescribeObjectRequest(BaseModel):
    description: str


class DescribeObjectResponse(BaseModel):
    object_id: str
    description: str | None
    description_edited_by_user: int
    training_example_created: bool


class TrainingStatsResponse(BaseModel):
    total: int
    by_label: dict[str, int]
    by_pdf_type: dict[str, int]
    ready_for_training: bool  # >= 200 tuples


class PageObjects(BaseModel):
    page_id: str
    page_number: int
    objects: list[ObjectResponse]


class DetectionResponse(BaseModel):
    document_id: str
    total_objects: int
    pages: list[PageObjects]


class EditAction(BaseModel):
    action: str  # confirm|reject|relabel|move|resize|delete|create|set_heading_level|auto_confirm
    object_id: str | None = None
    page_id: str | None = None  # for create
    label: str | None = None  # for relabel, create
    bbox_x1: float | None = None
    bbox_y1: float | None = None
    bbox_x2: float | None = None
    bbox_y2: float | None = None
    heading_level: int | None = None
    threshold: float | None = None  # for auto_confirm


class EditBatchRequest(BaseModel):
    edits: list[EditAction]


class EditBatchResponse(BaseModel):
    batch_id: str
    description: str
    affected_objects: list[dict]


class UndoRedoResponse(BaseModel):
    batch_id: str
    description: str
    action: str  # undo or redo


class UndoStateResponse(BaseModel):
    can_undo: bool
    undo_description: str | None
    can_redo: bool
    redo_description: str | None
    total_edits: int


class ReviewStatsResponse(BaseModel):
    total_objects: int
    confirmed: int
    rejected: int
    unreviewed: int
    pages_complete: int
    pages_total: int


class ExtractionResult(BaseModel):
    object_id: str
    content_type: str
    extractor: str


class ExtractionResponse(BaseModel):
    document_id: str
    total_extracted: int
    extractions: list[ExtractionResult]


class ExtractionDetail(BaseModel):
    id: str
    object_id: str
    content: str | None
    content_type: str
    extractor: str
    confidence: float | None
    metadata: dict


class ExtractionsListResponse(BaseModel):
    document_id: str
    total: int
    extractions: list[ExtractionDetail]


class AssemblyResponse(BaseModel):
    document_id: str
    markdown: str
    asset_count: int
    total_objects: int
    total_corrections: int


class QueueObject(BaseModel):
    object_id: str
    page_number: int
    label: str
    confidence: float | None
    status: str
    bbox_x1: float
    bbox_y1: float
    bbox_x2: float
    bbox_y2: float
    extraction_status: str  # extracted | placeholder | none


class QueueViewResponse(BaseModel):
    document_id: str
    total: int
    objects: list[QueueObject]
