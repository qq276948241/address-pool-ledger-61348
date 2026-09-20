import {AbstractIPNum, IPv4, IPv6} from "./IPNumber";

/**
 * Identifies which family a declared segment belongs to.
 */
export type AddressFamily = "IPv4" | "IPv6";

/**
 * Base class for every error raised while operating the address ledger.
 * Callers can distinguish failure reasons with the dedicated subclasses.
 */
export class AddressPoolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AddressPoolError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when an operation references a pool that was never created.
 * A pool that exists but has no free quota raises {@link PoolEmptyError}
 * instead, so "not created" and "empty" can be told apart.
 */
export class PoolNotFoundError extends AddressPoolError {
    constructor(poolName: string) {
        super(`Pool [${poolName}] does not exist`);
        this.name = "PoolNotFoundError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when a pool (or the requested family inside it) has no address
 * available for allocation.
 */
export class PoolEmptyError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "PoolEmptyError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when a declared segment is invalid on its own (reversed bounds,
 * zero addresses). This is different from {@link PoolEmptyError}: a segment
 * that is itself empty is rejected at construction time.
 */
export class InvalidSegmentError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidSegmentError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when an address does not belong to the segment/family it is used
 * against, or when an address that was never allocated is returned.
 */
export class AddressNotInPoolError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "AddressNotInPoolError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when an address that is not currently out is returned, or when the
 * same return is attempted twice.
 */
export class AddressNotOutError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "AddressNotOutError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when a return is attempted with a version that does not match the
 * version handed out at allocation time. The ledger is left untouched.
 */
export class VersionMismatchError extends AddressPoolError {
    public readonly expectedVersion: bigint;
    public readonly actualVersion: bigint;

    constructor(expectedVersion: bigint, actualVersion: bigint) {
        super(`Version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
        this.name = "VersionMismatchError";
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

interface LedgerEntry {
    family: AddressFamily;
    version: bigint;
}

interface SegmentState {
    family: AddressFamily;
    start: bigint;
    end: bigint;
    /**
     * Addresses currently available. A Set is used for the bookkeeping so
     * IPv4 and IPv6 can never share a slot (they live in separate states)
     * and so a removed address can never be handed out twice.
     */
    free: Set<bigint>;
}

export interface Allocation {
    address: string;
    value: bigint;
    family: AddressFamily;
    /**
     * Version that must be presented when returning the address. It changes
     * every time an address is allocated.
     */
    version: bigint;
}

export interface RemainingQuota {
    IPv4: bigint;
    IPv6: bigint;
}

export interface SegmentDefinition {
    name: string;
    family: AddressFamily;
    start: string;
    end: string;
}

/**
 * A single ledger ("one book") tracking the declared IPv4 and IPv6 segments,
 * the addresses currently allocated and the version of every allocation.
 */
export class AddressPoolLedger {
    /**
     * Segments keyed by family. IPv4 and IPv6 use distinct state objects so
     * one family can never occupy the other family's quota.
     */
    private readonly segments: Map<AddressFamily, SegmentState> = new Map();

    /**
     * Every address currently out, keyed by canonical numeric value.
     * Allocation and return mutate this map together with the segment's free
     * set, keeping the whole ledger consistent.
     */
    private readonly outstanding: Map<bigint, LedgerEntry> = new Map();

    /**
     * Every address that has been allocated at least once, even after it was
     * returned. Lets the ledger distinguish a duplicate return from the return
     * of an address that was never handed out.
     */
    private readonly everAllocated: Set<bigint> = new Set();

    /**
     * The address most recently returned. The next allocation of that family
     * hands it out first to make reconciliation easy.
     */
    private lastReturned: Map<AddressFamily, bigint> = new Map();

    private nextVersion: bigint = 1n;

    constructor(segments: Array<SegmentDefinition>) {
        if (!segments || segments.length === 0) {
            throw new InvalidSegmentError("At least one segment must be declared");
        }

        segments.forEach(definition => this.declareSegment(definition));
    }

    private declareSegment(definition: SegmentDefinition): void {
        if (this.segments.has(definition.family)) {
            throw new InvalidSegmentError(`Segment for ${definition.family} is already declared`);
        }
        const start = this.parseAddress(definition.start, definition.family);
        const end = this.parseAddress(definition.end, definition.family);

        if (start > end) {
            throw new InvalidSegmentError(
                `Segment [${definition.name}] start ${definition.start} is greater than end ${definition.end}`
            );
        }

        const free = new Set<bigint>();
        for (let value = start; value <= end; value = value + 1n) {
            free.add(value);
        }
        if (free.size === 0) {
            throw new InvalidSegmentError(`Segment [${definition.name}] is empty`);
        }

        this.segments.set(definition.family, {family: definition.family, start, end, free});
    }

    private parseAddress(address: string, family: AddressFamily): bigint {
        const ip: AbstractIPNum = family === "IPv4"
            ? IPv4.fromDecimalDottedString(address)
            : IPv6.fromHexadecatet(address);
        return ip.getValue();
    }

    private renderAddress(value: bigint, family: AddressFamily): string {
        return family === "IPv4"
            ? IPv4.fromNumber(value).toString()
            : IPv6.fromBigInt(value).toString();
    }

    /**
     * Allocate an address from the given family. The returned address always
     * falls inside the declared segment and is not already outstanding.
     *
     * Throws {@link PoolEmptyError} when the requested family has no free
     * quota; it never borrows from the other family.
     */
    public allocate(family: AddressFamily): Allocation {
        const segment = this.requireSegment(family);

        if (segment.free.size === 0) {
            throw new PoolEmptyError(`Pool is empty: no free ${family} address`);
        }

        const value = this.pickFree(segment);

        // Removing the slot and recording the allocation happen together, so a
        // concurrent second request can never take the same last slot.
        segment.free.delete(value);
        const version = this.nextVersion;
        this.nextVersion = this.nextVersion + 1n;
        this.outstanding.set(value, {family, version});
        this.everAllocated.add(value);
        this.lastReturned.delete(family);

        return {address: this.renderAddress(value, family), value, family, version};
    }

    private pickFree(segment: SegmentState): bigint {
        const recentlyReturned = this.lastReturned.get(segment.family);
        if (recentlyReturned !== undefined && segment.free.has(recentlyReturned)) {
            return recentlyReturned;
        }

        // Skip already-taken addresses rather than always returning the start
        // of the segment. The start address itself is included and may be
        // allocated like any other address.
        for (let value = segment.start; value <= segment.end; value = value + 1n) {
            if (segment.free.has(value)) {
                return value;
            }
        }
        throw new PoolEmptyError(`Pool is empty: no free ${segment.family} address`);
    }

    /**
     * Return a previously allocated address. A wrong version leaves the ledger
     * untouched and reports the expected version. Returning an address that was
     * never allocated (or returning twice) is rejected and never adds quota.
     */
    public release(address: string, family: AddressFamily, version: bigint): void {
        const segment = this.requireSegment(family);
        const value = this.parseAddress(address, family);
        const entry = this.outstanding.get(value);

        if (entry === undefined) {
            if (this.everAllocated.has(value)) {
                throw new AddressNotOutError(`Address ${address} is not currently allocated`);
            }
            throw new AddressNotInPoolError(`Address ${address} was never allocated from this pool`);
        }

        if (entry.version !== version) {
            throw new VersionMismatchError(entry.version, version);
        }

        // Restore quota and clear the outstanding record together so the
        // remaining count can never disagree with the outstanding set.
        this.outstanding.delete(value);
        if (value >= segment.start && value <= segment.end) {
            segment.free.add(value);
            this.lastReturned.set(family, value);
        }
    }

    private isDeclaredAddress(value: bigint, family: AddressFamily): boolean {
        const segment = this.segments.get(family);
        return segment !== undefined && value >= segment.start && value <= segment.end;
    }

    /**
     * Whether an address is currently out (allocated and not returned).
     * Out-of-segment addresses and the other family never match, even when the
     * numeric value is adjacent to a segment boundary.
     */
    public isOutstanding(address: string, family: AddressFamily): boolean {
        const value = this.parseAddress(address, family);
        const entry = this.outstanding.get(value);
        return entry !== undefined && entry.family === family;
    }

    /**
     * Whether an address belongs to the declared segment of its family.
     */
    public contains(address: string, family: AddressFamily): boolean {
        const value = this.parseAddress(address, family);
        return this.isDeclaredAddress(value, family);
    }

    /**
     * Remaining free quota for one family. This never adds the two families.
     */
    public remaining(family: AddressFamily): bigint {
        return BigInt(this.requireSegment(family).free.size);
    }

    /**
     * Remaining free quota reported separately per family.
     */
    public remainingByFamily(): RemainingQuota {
        return {
            IPv4: BigInt(this.segments.get("IPv4")?.free.size ?? 0),
            IPv6: BigInt(this.segments.get("IPv6")?.free.size ?? 0)
        };
    }

    /**
     * Change a segment's bounds after the pool was built. Addresses already
     * outstanding are unaffected and can still be returned. New allocations
     * use the new bounds. An empty revised segment is rejected.
     */
    public resizeSegment(family: AddressFamily, start: string, end: string): void {
        const existing = this.requireSegment(family);
        const newStart = this.parseAddress(start, family);
        const newEnd = this.parseAddress(end, family);

        if (newStart > newEnd) {
            throw new InvalidSegmentError(`Segment for ${family} start is greater than end`);
        }

        const free = new Set<bigint>();
        for (let value = newStart; value <= newEnd; value = value + 1n) {
            if (!this.outstanding.has(value)) {
                free.add(value);
            }
        }

        existing.start = newStart;
        existing.end = newEnd;
        existing.free = free;
        this.lastReturned.delete(family);
    }

    private requireSegment(family: AddressFamily): SegmentState {
        const segment = this.segments.get(family);
        if (segment === undefined) {
            throw new PoolEmptyError(`No ${family} segment declared in pool`);
        }
        return segment;
    }
}

/**
 * Registry of named ledgers. Allows operations to distinguish a pool that
 * was never created from a pool that simply has no free quota.
 */
export class AddressPoolRegistry {
    private readonly pools: Map<string, AddressPoolLedger> = new Map();

    public create(name: string, segments: Array<SegmentDefinition>): AddressPoolLedger {
        const pool = new AddressPoolLedger(segments);
        this.pools.set(name, pool);
        return pool;
    }

    public get(name: string): AddressPoolLedger {
        const pool = this.pools.get(name);
        if (pool === undefined) {
            throw new PoolNotFoundError(name);
        }
        return pool;
    }

    public exists(name: string): boolean {
        return this.pools.has(name);
    }

    public allocate(name: string, family: AddressFamily): Allocation {
        return this.get(name).allocate(family);
    }

    public release(name: string, address: string, family: AddressFamily, version: bigint): void {
        this.get(name).release(address, family, version);
    }
}
