package event

import (
	"context"
	"errors"
	"testing"
)

func mustPanic(t *testing.T, name string, f func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Errorf("%s did not panic", name)
		}
	}()
	f()
}

func TestMemoryLogAppendIsUnavailable(t *testing.T) {
	log := MemoryLog(NewBus(4))

	events, err := log.Append(context.Background(), "system", ConfigChanged{Section: "models", Rev: 1})
	if !errors.Is(err, ErrUnavailable) || events != nil {
		t.Errorf("Append = %v, %v; want nil, ErrUnavailable", events, err)
	}
	mustPanic(t, "Append of an ephemeral payload", func() {
		_, _ = log.Append(context.Background(), "system", tick{1})
	})
}

func TestMemoryLogPublish(t *testing.T) {
	log := MemoryLog(NewBus(4))
	_, ch, cancel := log.Subscribe(Filter{})
	defer cancel()

	log.Publish("system", counter{7})

	if e, ok := recv(t, ch); !ok || describe(e) != `system test.counter {"n":7}` {
		t.Errorf("subscriber got %+v, open %v", e, ok)
	}
	retained, _, cancel2 := log.Subscribe(Filter{})
	cancel2()
	if len(retained) != 1 || describe(retained[0]) != `system test.counter {"n":7}` {
		t.Errorf("retained = %v, want the counter", describeAll(retained))
	}
	mustPanic(t, "Publish of a durable payload", func() {
		log.Publish("system", ConfigChanged{Section: "models", Rev: 1})
	})
}

func TestMemoryLogRead(t *testing.T) {
	log := MemoryLog(NewBus(4))

	events, err := log.Read(context.Background(), 0, Filter{}, 1000)
	if err != nil || events == nil || len(events) != 0 {
		t.Errorf("Read = %v, %v; want an empty slice", events, err)
	}
	for _, limit := range []int{0, 1001} {
		mustPanic(t, "Read with a bad limit", func() {
			_, _ = log.Read(context.Background(), 0, Filter{}, limit)
		})
	}
}

func TestMemoryLogInfo(t *testing.T) {
	info, err := MemoryLog(NewBus(4)).Info(context.Background())
	if err != nil || info != (Info{ID: "", Head: 0}) {
		t.Errorf("Info = %+v, %v; want {\"\", 0}", info, err)
	}
}
