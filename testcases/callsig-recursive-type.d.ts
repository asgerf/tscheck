interface Foo {
	f: Bar
}
interface Bar {
	g: Foo
}

declare function good(x:Foo): Bar;
declare function bad(x:Foo): Foo;
