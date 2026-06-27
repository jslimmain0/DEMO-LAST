package com.flowlink.transform;

import java.util.List;
import java.util.Map;

/**
 * 변환(transform) SPI. 내장 변환과 JAR 플러그인이 동일하게 구현한다.
 *
 * <p>플러그인은 {@link #inputs()}/{@link #outputs()} 로 <b>입력/출력 개수와 이름</b>을 직접 선언하고,
 * {@link #apply(Map, Map)} 에서 이름별 입력을 받아 이름별 출력을 돌려준다. 속성 패널은 선언된 입력 수만큼
 * 바인딩 칸을 그리고, 선언된 출력은 하위 노드에서 바인딩 가능해진다.
 *
 * <p>JAR 작성: 이 인터페이스를 구현하고 {@code META-INF/services/com.flowlink.transform.FlowTransform}
 * 에 클래스명을 등록하면 ServiceLoader로 로드된다. (신뢰 JAR 전용 — 샌드박스 없음)
 */
public interface FlowTransform {

    /** 고유 식별자(노드의 transformId 와 매칭). */
    String id();

    /** UI 표시 이름. */
    String label();

    /** 입력 포트 선언(개수/이름/타입). 기본: 단일 입력 "input". */
    default List<IoSpec> inputs() {
        return List.of(IoSpec.of("input", "입력"));
    }

    /** 출력 포트 선언(개수/이름/타입). 기본: 단일 출력 "result". */
    default List<IoSpec> outputs() {
        return List.of(IoSpec.of("result", "결과"));
    }

    /** 설정 파라미터 스키마(UI 폼 생성용). */
    default List<TransformParam> params() {
        return List.of();
    }

    /** 이름별 입력 → 이름별 출력. (선언한 outputs 의 key 로 결과를 담아 반환) */
    Map<String, String> apply(Map<String, String> inputs, Map<String, String> config);

    /** 입력/출력 포트 정의. */
    record IoSpec(String key, String label, String type) {
        public static IoSpec of(String key, String label) {
            return new IoSpec(key, label, "string");
        }
    }

    record TransformParam(String key, String label, String type, String defaultValue) {
        public static TransformParam of(String key, String label) {
            return new TransformParam(key, label, "string", "");
        }

        public static TransformParam of(String key, String label, String defaultValue) {
            return new TransformParam(key, label, "string", defaultValue);
        }
    }
}
