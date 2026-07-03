package com.flowlink.mock;

import com.flowlink.mock.MockDtos.CreateMockServerRequest;
import com.flowlink.mock.MockDtos.MockServerDetail;
import com.flowlink.mock.MockDtos.MockServerSummary;
import com.flowlink.mock.MockDtos.UpdateMockServerRequest;
import com.flowlink.mock.MockDtos.UpdateMockSpecRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/** Mock 서버 관리 CRUD (테넌트 스코프). 서빙은 {@link MockGatewayController}. */
@RestController
@RequestMapping("/api/v1/mock-servers")
public class MockServerController {

    private final MockServerService service;

    public MockServerController(MockServerService service) {
        this.service = service;
    }

    @GetMapping
    public List<MockServerSummary> list() {
        return service.list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public MockServerDetail create(@Valid @RequestBody CreateMockServerRequest req) {
        return service.create(req);
    }

    @GetMapping("/{id}")
    public MockServerDetail get(@PathVariable UUID id) {
        return service.get(id);
    }

    @PatchMapping("/{id}")
    public MockServerDetail update(@PathVariable UUID id, @RequestBody UpdateMockServerRequest req) {
        return service.updateMeta(id, req);
    }

    @PutMapping("/{id}/spec")
    public MockServerDetail updateSpec(@PathVariable UUID id, @RequestBody UpdateMockSpecRequest req) {
        return service.updateSpec(id, req.spec());
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        service.delete(id);
    }
}
