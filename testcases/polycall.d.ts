interface Foo {
	f: number;
}
declare function good<T extends Foo>(x:T): number;

interface Bar<T> {
	f: T;
}
declare function good2<T extends Bar<T>>(x:T): T;
declare function bad<T extends Bar<T>>(x:T): T;
