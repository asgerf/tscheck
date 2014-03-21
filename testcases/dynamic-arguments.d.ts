interface Foo {
	foo: number
}
interface Bar {
	foo: {};
}

declare function foo(): Foo;

declare function bad(): Bar;
