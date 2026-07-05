package com.flowlink.transform;

import com.flowlink.transform.FlowTransform.IoSpec;
import com.flowlink.transform.FlowTransform.TransformParam;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** 사용 가능한 변환 목록(내장+플러그인) 제공 — 프론트 transform 노드 UI가 소비. */
@RestController
@RequestMapping("/api/v1/transforms")
public class TransformController {

    private final TransformRegistry registry;

    public TransformController(TransformRegistry registry) {
        this.registry = registry;
    }

    public record TransformInfo(String id, String label, List<IoSpec> inputs, List<IoSpec> outputs, List<TransformParam> params) {
        static TransformInfo from(FlowTransform t) {
            return new TransformInfo(t.id(), t.label(), t.inputs(), t.outputs(), t.params());
        }
    }

    @GetMapping
    public List<TransformInfo> list() {
        return registry.list().stream().map(TransformInfo::from).toList();
    }
}
