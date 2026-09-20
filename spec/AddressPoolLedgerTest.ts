import {
    AddressPoolLedger,
    AddressPoolRegistry,
    AddressNotInPoolError,
    AddressNotOutError,
    InvalidSegmentError,
    PoolEmptyError,
    PoolNotFoundError,
    VersionMismatchError
} from "../src";

describe("AddressPoolLedger", () => {
    const smallPool = () => new AddressPoolLedger([
        {name: "v4", family: "IPv4", start: "10.0.0.1", end: "10.0.0.3"},
        {name: "v6", family: "IPv6", start: "2001:db8::1", end: "2001:db8::3"}
    ]);

    it("takes an in-segment address that is not already out, and can take it again after release (single-address pool)", () => {
        const pool = new AddressPoolLedger([
            {name: "only", family: "IPv4", start: "10.0.0.9", end: "10.0.0.9"}
        ]);

        const first = pool.allocate("IPv4");
        expect(first.address).toEqual("10.0.0.9");
        expect(pool.remaining("IPv4")).toEqual(0n);

        pool.release(first.address, "IPv4", first.version);
        expect(pool.remaining("IPv4")).toEqual(1n);

        const second = pool.allocate("IPv4");
        expect(second.address).toEqual("10.0.0.9");
    });

    it("reports which family an allocated address comes from", () => {
        const pool = smallPool();
        const v4 = pool.allocate("IPv4");
        const v6 = pool.allocate("IPv6");
        expect(v4.family).toEqual("IPv4");
        expect(v4.address).toEqual("10.0.0.1");
        expect(v6.family).toEqual("IPv6");
        expect(v6.value).toEqual(0x20010db8000000000000000000000001n);
        expect(pool.contains(v6.address, "IPv6")).toBeTrue();
    });

    it("does not hand out an address that is already outstanding", () => {
        const pool = smallPool();
        const a = pool.allocate("IPv4");
        const b = pool.allocate("IPv4");
        expect(a.address).not.toEqual(b.address);
        expect(pool.isOutstanding(a.address, "IPv4")).toBeTrue();
        expect(pool.isOutstanding(b.address, "IPv4")).toBeTrue();
    });

    it("rejects returning an address that was never allocated, without adding quota", () => {
        const pool = smallPool();
        const before = pool.remaining("IPv4");
        expect(() => pool.release("10.0.0.2", "IPv4", 1n)).toThrowError(AddressNotInPoolError);
        expect(pool.remaining("IPv4")).toEqual(before);
    });

    it("rejects a duplicate return and never counts the slot twice", () => {
        const pool = smallPool();
        const a = pool.allocate("IPv4");
        pool.release(a.address, "IPv4", a.version);
        expect(pool.remaining("IPv4")).toEqual(3n);
        expect(() => pool.release(a.address, "IPv4", a.version)).toThrowError(AddressNotOutError);
        expect(pool.remaining("IPv4")).toEqual(3n);
    });

    it("stops and reports empty instead of returning an out-of-segment address", () => {
        const pool = new AddressPoolLedger([
            {name: "only", family: "IPv4", start: "10.0.0.9", end: "10.0.0.9"}
        ]);
        pool.allocate("IPv4");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolEmptyError, /empty/i);
    });

    it("does not borrow from IPv6 when IPv4 is empty", () => {
        const pool = new AddressPoolLedger([
            {name: "v4", family: "IPv4", start: "10.0.0.9", end: "10.0.0.9"},
            {name: "v6", family: "IPv6", start: "2001:db8::1", end: "2001:db8::5"}
        ]);
        pool.allocate("IPv4");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolEmptyError);
        expect(pool.remaining("IPv6")).toEqual(5n);
        const v6 = pool.allocate("IPv6");
        expect(v6.family).toEqual("IPv6");
    });

    it("treats collapsed and expanded IPv6 forms as the same slot", () => {
        const pool = new AddressPoolLedger([
            {name: "v6", family: "IPv6", start: "2001:db8::1", end: "2001:db8::1"}
        ]);
        const allocated = pool.allocate("IPv6");
        expect(pool.isOutstanding("2001:0db8:0000:0000:0000:0000:0000:0001", "IPv6")).toBeTrue();
        pool.release("2001:0db8:0000:0000:0000:0000:0000:0001", "IPv6", allocated.version);
        expect(pool.isOutstanding("2001:db8::1", "IPv6")).toBeFalse();
        expect(pool.remaining("IPv6")).toEqual(1n);
    });

    it("prefers the just-returned address on the next allocation", () => {
        const pool = smallPool();
        pool.allocate("IPv4");
        const second = pool.allocate("IPv4");
        pool.release(second.address, "IPv4", second.version);
        const next = pool.allocate("IPv4");
        expect(next.address).toEqual(second.address);
    });

    it("allocates the start address and then the end address; only after the end is taken is it empty", () => {
        const pool = new AddressPoolLedger([
            {name: "v4", family: "IPv4", start: "192.168.0.1", end: "192.168.0.2"}
        ]);
        const first = pool.allocate("IPv4");
        expect(first.address).toEqual("192.168.0.1");
        const last = pool.allocate("IPv4");
        expect(last.address).toEqual("192.168.0.2");
        expect(() => pool.allocate("IPv4")).toThrowError(PoolEmptyError);
    });

    it("reports IPv4 and IPv6 remaining separately, never summed", () => {
        const pool = smallPool();
        pool.allocate("IPv4");
        pool.allocate("IPv6");
        pool.allocate("IPv6");
        expect(pool.remaining("IPv4")).toEqual(2n);
        expect(pool.remaining("IPv6")).toEqual(1n);
        expect(pool.remainingByFamily()).toEqual({IPv4: 2n, IPv6: 1n});
    });

    it("fails at construction when no segment is declared (empty segment, not empty pool)", () => {
        expect(() => new AddressPoolLedger([])).toThrowError(InvalidSegmentError);
    });

    it("fails at construction for a reversed segment", () => {
        expect(() => new AddressPoolLedger([
            {name: "bad", family: "IPv4", start: "10.0.0.2", end: "10.0.0.1"}
        ])).toThrowError(InvalidSegmentError);
    });

    it("keeps allocated addresses contained in their segment", () => {
        const pool = smallPool();
        const a = pool.allocate("IPv4");
        expect(pool.contains(a.address, "IPv4")).toBeTrue();
        expect(pool.contains("10.0.0.4", "IPv4")).toBeFalse();
    });

    it("rejects a return with the wrong version, leaves the ledger untouched, and reports expected version", () => {
        const pool = smallPool();
        const a = pool.allocate("IPv4");
        let caught: unknown;
        try {
            pool.release(a.address, "IPv4", a.version + 1n);
        } catch (e) {
            caught = e;
        }
        expect(caught instanceof VersionMismatchError).toBeTrue();
        expect((caught as VersionMismatchError).expectedVersion).toEqual(a.version);
        expect(pool.isOutstanding(a.address, "IPv4")).toBeTrue();
        expect(pool.remaining("IPv4")).toEqual(2n);
    });

    it("allows lookup by address and flips to not-outstanding after release", () => {
        const pool = smallPool();
        const a = pool.allocate("IPv4");
        expect(pool.isOutstanding(a.address, "IPv4")).toBeTrue();
        pool.release(a.address, "IPv4", a.version);
        expect(pool.isOutstanding(a.address, "IPv4")).toBeFalse();
    });

    it("never reports an out-of-segment (even adjacent) address as outstanding", () => {
        const pool = smallPool();
        pool.allocate("IPv4");
        expect(pool.isOutstanding("10.0.0.4", "IPv4")).toBeFalse();
    });

    it("does not cross IPv4/IPv6 query results", () => {
        const pool = smallPool();
        const v4 = pool.allocate("IPv4");
        const v6 = pool.allocate("IPv6");
        expect(pool.isOutstanding(v4.address, "IPv4")).toBeTrue();
        expect(pool.isOutstanding(v6.address, "IPv6")).toBeTrue();

        // The same rendered label cannot be valid in the other family, and a
        // numeric collision must not leak between ledgers.
        expect(pool.isOutstanding("0.0.0.0", "IPv4")).toBeFalse();
        expect(pool.isOutstanding("::", "IPv6")).toBeFalse();
    });

    it("reports zero remaining when every slot is out", () => {
        const pool = new AddressPoolLedger([
            {name: "v4", family: "IPv4", start: "10.0.0.1", end: "10.0.0.2"}
        ]);
        pool.allocate("IPv4");
        pool.allocate("IPv4");
        expect(pool.remaining("IPv4")).toEqual(0n);
    });

    it("allows only one winner when the last slot is taken, and the loser sees an empty pool", () => {
        const pool = new AddressPoolLedger([
            {name: "only", family: "IPv4", start: "10.0.0.9", end: "10.0.0.9"}
        ]);

        let winner: ReturnType<AddressPoolLedger["allocate"]> | undefined;
        let loserError: unknown;

        // Two synchronous contenders; only one can delete the last free slot.
        try {
            winner = pool.allocate("IPv4");
        } catch (e) {
            loserError = e;
        }
        try {
            const other = pool.allocate("IPv4");
            if (winner === undefined) {
                winner = other;
            } else {
                loserError = other;
            }
        } catch (e) {
            loserError = e;
        }

        expect(winner).toBeDefined();
        expect(loserError instanceof PoolEmptyError).toBeTrue();
        expect(pool.remaining("IPv4")).toEqual(0n);
    });

    it("restores remaining count together with removing the outstanding record on release", () => {
        const pool = new AddressPoolLedger([
            {name: "only", family: "IPv4", start: "10.0.0.9", end: "10.0.0.9"}
        ]);
        const a = pool.allocate("IPv4");
        expect(pool.remaining("IPv4")).toEqual(0n);
        expect(pool.isOutstanding(a.address, "IPv4")).toBeTrue();
        pool.release(a.address, "IPv4", a.version);
        expect(pool.remaining("IPv4")).toEqual(1n);
        expect(pool.isOutstanding(a.address, "IPv4")).toBeFalse();
    });

    it("does not let post-build segment resizing affect outstanding addresses", () => {
        const pool = new AddressPoolLedger([
            {name: "v4", family: "IPv4", start: "10.0.0.1", end: "10.0.0.2"}
        ]);
        const a = pool.allocate("IPv4");
        pool.resizeSegment("IPv4", "10.0.0.9", "10.0.0.10");

        // The old outstanding address remains returnable even though it is
        // outside the new segment.
        pool.release(a.address, "IPv4", a.version);

        const fresh = pool.allocate("IPv4");
        expect(fresh.address).toEqual("10.0.0.9");
    });

    it("distinguishes a family with no declared segment from an empty pool", () => {
        const pool = new AddressPoolLedger([
            {name: "v4", family: "IPv4", start: "10.0.0.1", end: "10.0.0.1"}
        ]);
        expect(() => pool.allocate("IPv6")).toThrowError(PoolEmptyError);
    });
});

describe("AddressPoolRegistry", () => {
    it("distinguishes a missing pool from an empty one", () => {
        const registry = new AddressPoolRegistry();
        expect(registry.exists("nope")).toBeFalse();
        expect(() => registry.allocate("nope", "IPv4")).toThrowError(PoolNotFoundError);

        registry.create("main", [
            {name: "v4", family: "IPv4", start: "10.0.0.1", end: "10.0.0.1"}
        ]);
        const a = registry.allocate("main", "IPv4");
        expect(() => registry.allocate("main", "IPv4")).toThrowError(PoolEmptyError);
        registry.release("main", a.address, "IPv4", a.version);
        expect(registry.get("main").remaining("IPv4")).toEqual(1n);
    });
});
