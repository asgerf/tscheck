interface Foo {
	f: Bar
}
interface Bar {
	g: Foo
}

declare function getF(x:Foo): Bar;
