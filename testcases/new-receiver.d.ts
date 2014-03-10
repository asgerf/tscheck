class Foo {
	x: number;
	constructor(x:number);
	bar(): Foo;
}

declare function good(): Foo;
declare function bad(): Foo;