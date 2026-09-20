import {AbstractIPNum, IPv4, IPv6} from "./IPNumber";
import {collapseIPv6Number} from "./IPv6Utils";

/**
 * Identifies which family a declared segment belongs to.
 */
export type AddressFamily = "IPv4" | "IPv6";

/**
 * Base class for every error raised while operating the address ledger.
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
 * Raised when a pool (or a declared family inside it) has no address left to
 * allocate. It never hands out an out-of-segment address and never borrows
 * from the other family.
 */
export class PoolEmptyError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "PoolEmptyError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when no segment of the requested family is declared in the pool.
 * Kept separate from {@link PoolEmptyError} so "segment absent" can be told
 * apart from "segment present but drained".
 */
export class SegmentNotDeclaredError extends AddressPoolError {
    constructor(family: AddressFamily) {
        super(`No ${family} segment is declared in this pool`);
        this.name = "SegmentNotDeclaredError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when a declared segment is invalid on its own (reversed bounds, no
 * segments declared at all). A segment that is itself empty is rejected at
 * construction time rather than on the first allocation.
 */
export class InvalidSegmentError extends AddressPoolError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidSegmentError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when an address is returned that was never allocated from the pool.
 */
export class AddressNotAllocatedError extends AddressPoolError {
    constructor(address: string) {
        super(`Address ${address} was never allocated from this pool`);
        this.name = "AddressNotAllocatedError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when an address that is not currently out is returned, including a
 * second return of the same allocation. The quota is never added twice.
 */
export class AddressNotOutError extends AddressPoolError {
    constructor(address: string) {
        super(`Address ${address} is not currently allocated`);
        this.name = "AddressNotOutError";
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/**
 * Raised when a return presents a version different from the one handed out
 * at allocation time. The ledger is left untouched and the expected version
 * is reported.
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

export interface SegmentDefinition {
    name: string;
    family: AddressFamily;
    start: string;
    end: string;
}

export interface Allocation {
    /** Canonical rendering of the allocated address. */
    address: string;
    /** Numeric value of the allocated address. */
    value: bigint;
    /** Family the address was allocated from. */
    family: AddressFamily;
    /** Name of the declared segment the address came from. */
    segment: string;
    /** Version that must be presented when returning the address. */
    version: bigint;
}

export interface RemainingQuota {
    IPv4: bigint;
    IPv6: bigint;
}

interface OutstandingEntry {
    version: bigint;
    segment: string;
}

interface FamilyLedger {
    family: AddressFamily;
    segmentName: string;
    start: bigint;
    end: bigint;
    /**
     * Addresses currently available inside the current segment. Allocation
     * removes from this set and return adds back to it, so remaining count
     * and the outstanding records can never disagree.
     */
    free: Set<bigint>;
    /**
     * Addresses currently out, with the version required to return them.
     * Kept per family so IPv4 and IPv6 numeric values can never collide.
     */
    outstanding: Map<bigint, OutstandingEntry>;
    /** Values handed out at least once, even after they were returned. */
    everAllocated: Set<bigint>;
    /** Most recently returned value; preferred on the next allocation. */
    lastReturned?: bigint;
}

/**
 * A single ledger ("one book") tracking the declared IPv4 and IPv6 segments,
 * the addresses currently out and the version of every allocation.
 *
 * Each family keeps its own free set and outstanding records, so the two
 * families can never occupy each other's slots.
 */
export class AddressPoolLedger {
    private readonly ledgers: Map<AddressFamily, FamilyLedger> = new Map();
    private nextVersion: bigint = 1n;

    constructor(segments: Array<SegmentDefinition>) {
        if (!segments || segments.length === 0) {
            throw new InvalidSegmentError("At least one non-empty segment must be declared");
        }
        segments.forEach(segment => this.declareSegment(segment));
    }

    private declareSegment(definition: SegmentDefinition): void {
        if (this.ledgers.has(definition.family)) {
            throw new InvalidSegmentError(`A ${definition.family} segment is already declared`);
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

        this.ledgers.set(definition.family, {
            family: definition.family,
            segmentName: definition.name,
            start,
            end,
            free,
            outstanding: new Map<bigint, OutstandingEntry>(),
            everAllocated: new Set<bigint>()
        });
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
            : collapseIPv6Number(IPv6.fromBigInt(value).toString());
    }

    private requireLedger(family: AddressFamily): FamilyLedger {
        const ledger = this.ledgers.get(family);
        if (ledger === undefined) {
            throw new SegmentNotDeclaredError(family);
        }
        return ledger;
    }

    /**
     * Allocate one address from the given family's segment. The result always
     * falls inside the declared segment and is not already out.
     *
     * Throws {@link PoolEmptyError} when no free slot remains; it never
     * borrows from the other family and never returns an out-of-segment
     * address.
     */
    public allocate(family: AddressFamily): Allocation {
        const ledger = this.requireLedger(family);

        if (ledger.free.size === 0) {
            throw new PoolEmptyError(`Pool is empty: no free ${family} address`);
        }

        const value = this.pickFree(ledger);

        // Delete the slot and write the outstanding record in the same
        // synchronous step, so a concurrent contender for the last slot sees
        // an empty pool.
        ledger.free.delete(value);
        const version = this.nextVersion;
        this.nextVersion = this.nextVersion + 1n;
        ledger.outstanding.set(value, {version, segment: ledger.segmentName});
        ledger.everAllocated.add(value);
        ledger.lastReturned = undefined;

        return {
            address: this.renderAddress(value, family),
            value,
            family,
            segment: ledger.segmentName,
            version
        };
    }

    private pickFree(ledger: FamilyLedger): bigint {
        if (ledger.lastReturned !== undefined && ledger.free.has(ledger.lastReturned)) {
            return ledger.lastReturned;
        }

        // Scan from the inclusive start, skipping already-taken addresses,
        // instead of always handing back the first address of the segment.
        for (let value = ledger.start; value <= ledger.end; value = value + 1n) {
            if (ledger.free.has(value)) {
                return value;
            }
        }

        throw new PoolEmptyError(`Pool is empty: no free ${ledger.family} address`);
    }

    /**
     * Return a previously allocated address.
     *
     * A wrong version leaves the ledger untouched and reports the expected
     * version. Returning an address that was never allocated, or returning an
     * address twice, is rejected and never adds quota.
     */
    public release(address: string, family: AddressFamily, version: bigint): void {
        const ledger = this.requireLedger(family);
        const value = this.parseAddress(address, family);
        const entry = ledger.outstanding.get(value);

        if (entry === undefined) {
            if (ledger.everAllocated.has(value)) {
                throw new AddressNotOutError(address);
            }
            throw new AddressNotAllocatedError(address);
        }

        if (entry.version !== version) {
            throw new VersionMismatchError(entry.version, version);
        }

        // Remove the outstanding record and restore the quota together. If the
        // segment was resized while the address was out, the retired slot is
        // not made allocatable again.
        ledger.outstanding.delete(value);
        if (value >= ledger.start && value <= ledger.end) {
            ledger.free.add(value);
        }
        ledger.lastReturned = value;
    }

    /**
     * Whether an address is currently out (allocated and not returned).
     * Out-of-segment addresses and the other family never match, even when
     * the numeric value is adjacent to a segment boundary.
     */
    public isOutstanding(address: string, family: AddressFamily): boolean {
        const value = this.parseAddress(address, family);
        return this.ledgers.get(family)?.outstanding.has(value) ?? false;
    }

    /**
     * Whether an address falls inside the currently declared segment of the
     * given family.
     */
    public contains(address: string, family: AddressFamily): boolean {
        const value = this.parseAddress(address, family);
        const ledger = this.ledgers.get(family);
        return ledger !== undefined && value >= ledger.start && value <= ledger.end;
    }

    /** Remaining free quota for one family; the two families are never summed. */
    public remaining(family: AddressFamily): bigint {
        return BigInt(this.requireLedger(family).free.size);
    }

    /** Remaining free quota reported separately per family. */
    public remainingByFamily(): RemainingQuota {
        return {
            IPv4: BigInt(this.ledgers.get("IPv4")?.free.size ?? 0),
            IPv6: BigInt(this.ledgers.get("IPv6")?.free.size ?? 0)
        };
    }

    /**
     * Change a segment's bounds after the pool was built. Addresses already
     * outstanding stay valid and returnable. New allocations use the new
     * bounds; slots carried over from the old bounds but outside the new ones
     * are retired once returned. A reversed revised segment is rejected.
     */
    public resizeSegment(family: AddressFamily, start: string, end: string): void {
        const ledger = this.requireLedger(family);
        const newStart = this.parseAddress(start, family);
        const newEnd = this.parseAddress(end, family);

        if (newStart > newEnd) {
            throw new InvalidSegmentError(`Resized ${family} segment start is greater than end`);
        }

        const free = new Set<bigint>();
        for (let value = newStart; value <= newEnd; value = value + 1n) {
            if (!ledger.outstanding.has(value)) {
                free.add(value);
            }
        }

        ledger.start = newStart;
        ledger.end = newEnd;
        ledger.free = free;
        ledger.lastReturned = undefined;
    }
}

/**
 * Registry of named ledgers. Lets operations distinguish a pool that was
 * never created from a pool that simply has no free quota.
 */
export class AddressPoolRegistry {
    private readonly pools: Map<string, AddressPoolLedger> = new Map();

    public create(name: string, segments: Array<SegmentDefinition>): AddressPoolLedger {
        if (this.pools.has(name)) {
            throw new AddressPoolError(`Pool [${name}] already exists`);
        }
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
