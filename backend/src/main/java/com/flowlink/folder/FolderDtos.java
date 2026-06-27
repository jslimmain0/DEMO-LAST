package com.flowlink.folder;

import com.flowlink.core.domain.Folder;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.UUID;

/** 폴더 관련 DTO 모음. */
public final class FolderDtos {

    private FolderDtos() {
    }

    public record FolderRequest(@NotBlank @Size(max = 255) String name) {
    }

    public record FolderSummary(UUID id, String name, long flowCount, Instant createdAt) {
        public static FolderSummary from(Folder f, long flowCount) {
            return new FolderSummary(f.getId(), f.getName(), flowCount, f.getCreatedAt());
        }
    }

    /** 워크플로를 폴더로 이동(null = 미분류). */
    public record MoveFlowRequest(UUID folderId) {
    }
}
