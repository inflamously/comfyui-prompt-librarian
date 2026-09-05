"""The change bus: ordered delivery, isolation from failing subscribers."""

from prompt_librarian.shared.events import Change, EventBus


def test_subscribers_run_in_order_and_can_unsubscribe():
    bus, seen = EventBus(), []
    bus.subscribe(lambda change: seen.append(("first", change.op)))
    off = bus.subscribe(lambda change: seen.append(("second", change.op)))
    bus.emit(Change("create"))
    off()
    bus.emit(Change("delete"))
    assert seen == [("first", "create"), ("second", "create"), ("first", "delete")]


def test_a_failing_subscriber_does_not_stop_the_others():
    bus, seen = EventBus(), []

    def boom(_change):
        raise RuntimeError("broken cache")

    bus.subscribe(boom)
    bus.subscribe(lambda change: seen.append(change.new_rev))
    bus.emit(Change("usage", old_rev=4, new_rev=5, bodies_changed=False))
    assert seen == [5]
