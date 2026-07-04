package com.flowlink.mock;

import com.fasterxml.jackson.databind.JsonNode;
import com.flowlink.common.error.BadRequestException;
import com.flowlink.common.error.NotFoundException;
import com.flowlink.common.json.JsonService;
import com.flowlink.common.tenant.TenantContext;
import com.flowlink.core.domain.MockServer;
import com.flowlink.core.repository.MockServerRepository;
import com.flowlink.mock.MockDtos.CreateMockServerRequest;
import com.flowlink.mock.MockDtos.MockServerDetail;
import com.flowlink.mock.MockDtos.MockServerSummary;
import com.flowlink.mock.MockDtos.UpdateMockServerRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/** Mock 서버 관리(테넌트 스코프 CRUD) + 서빙 조회(무인증, slug 전역 유니크). */
@Service
public class MockServerService {

    private static final Pattern SLUG = Pattern.compile("[a-z0-9-]{3,40}");

    private final MockServerRepository repository;
    private final JsonService json;

    public MockServerService(MockServerRepository repository, JsonService json) {
        this.repository = repository;
        this.json = json;
    }

    @Transactional(readOnly = true)
    public List<MockServerSummary> list() {
        return repository.findByTenantIdOrderByUpdatedAtDesc(tenant()).stream()
                .map(this::toSummary)
                .toList();
    }

    @Transactional
    public MockServerDetail create(CreateMockServerRequest req) {
        String slug = req.slug().toLowerCase(Locale.ROOT);
        if (!SLUG.matcher(slug).matches()) {
            throw new BadRequestException("slug 는 소문자·숫자·하이픈 3~40자여야 합니다: " + slug);
        }
        if (repository.existsBySlug(slug)) {
            throw new BadRequestException("이미 사용 중인 slug 입니다: " + slug);
        }
        MockServer saved = repository.save(
                MockServer.create(tenant(), req.name(), slug, MockServer.Kind.CUSTOM, defaultCustomSpec()));
        return toDetail(saved);
    }

    @Transactional(readOnly = true)
    public MockServerDetail get(UUID id) {
        return toDetail(find(id));
    }

    @Transactional
    public MockServerDetail updateMeta(UUID id, UpdateMockServerRequest req) {
        MockServer m = find(id);
        if (req.name() != null && !req.name().isBlank()) {
            m.setName(req.name());
        }
        if (req.enabled() != null) {
            m.setEnabled(req.enabled());
        }
        return toDetail(repository.save(m));
    }

    @Transactional
    public MockServerDetail updateSpec(UUID id, JsonNode spec) {
        MockServer m = find(id);
        if (spec == null || spec.isNull()) {
            throw new BadRequestException("spec 이 없습니다.");
        }
        String raw = spec.toString();
        // 저장 전 파싱 검증 — 깨진 spec 이 게이트웨이에서 500 을 만들지 않게 한다
        parseSpec(raw);
        m.setSpecJson(raw);
        return toDetail(repository.save(m));
    }

    @Transactional
    public void delete(UUID id) {
        repository.delete(find(id));
    }

    /** 게이트웨이 서빙용 — 무인증·테넌트 무관(slug 전역 유니크). */
    @Transactional(readOnly = true)
    public Optional<MockServer> findForServing(String slug) {
        return repository.findBySlug(slug).filter(MockServer::isEnabled);
    }

    public MockSpec parseSpec(String specJson) {
        if (specJson == null || specJson.isBlank()) {
            return new MockSpec(List.of());
        }
        try {
            MockSpec spec = json.mapper().readValue(specJson, MockSpec.class);
            return spec == null ? new MockSpec(List.of()) : spec;
        } catch (Exception e) {
            throw new BadRequestException("mock spec JSON 파싱 실패: " + e.getMessage());
        }
    }

    private MockServer find(UUID id) {
        return repository.findByIdAndTenantId(id, tenant())
                .orElseThrow(() -> new NotFoundException("Mock 서버가 없습니다: " + id));
    }

    private MockServerSummary toSummary(MockServer m) {
        return new MockServerSummary(m.getId(), m.getName(), m.getSlug(), m.getKind().name(),
                m.isEnabled(), m.getUpdatedAt());
    }

    private MockServerDetail toDetail(MockServer m) {
        JsonNode spec = m.getSpecJson() == null || m.getSpecJson().isBlank()
                ? json.mapper().createObjectNode()
                : json.readTree(m.getSpecJson());
        return new MockServerDetail(m.getId(), m.getName(), m.getSlug(), m.getKind().name(),
                m.isEnabled(), spec, m.getCreatedAt(), m.getUpdatedAt());
    }

    private static String tenant() {
        return TenantContext.getTenantId();
    }

    /** 새 CUSTOM 서버의 시작 예시 — 편집기에서 바로 고쳐 쓰는 안내 겸용. */
    private String defaultCustomSpec() {
        return """
                {"routes":[{"id":"r1","method":"GET","path":"/hello","rules":[
                  {"id":"u1","status":200,"contentType":"json",
                   "body":"{\\"message\\":\\"안녕하세요 {{query.name}}\\",\\"seq\\":\\"{{seq}}\\"}"}
                ]}]}""";
    }
}
