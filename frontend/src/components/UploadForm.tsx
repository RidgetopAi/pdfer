import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { uploadDocument } from "../api/client";

export function UploadForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: uploadDocument,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const file = files[0];
    if (!file.name.toLowerCase().endsWith(".pdf")) return;
    mutation.mutate(file);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
      style={{
        border: `2px dashed ${dragging ? "#3b82f6" : "#666"}`,
        borderRadius: 8,
        padding: "24px",
        textAlign: "center",
        background: dragging ? "#1e293b" : "#0f172a",
        transition: "all 0.15s",
        marginBottom: 24,
      }}
    >
      <p style={{ margin: "0 0 12px", color: "#94a3b8" }}>
        {mutation.isPending ? "Uploading and ingesting..." : "Drop a PDF here or click to upload"}
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        onChange={(e) => handleFiles(e.target.files)}
        style={{ display: "none" }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={mutation.isPending}
        style={{
          padding: "8px 20px",
          background: "#3b82f6",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: mutation.isPending ? "wait" : "pointer",
          fontSize: 14,
        }}
      >
        {mutation.isPending ? "Processing..." : "Select PDF"}
      </button>
      {mutation.isError && (
        <p style={{ color: "#ef4444", marginTop: 8 }}>{(mutation.error as Error).message}</p>
      )}
    </div>
  );
}
