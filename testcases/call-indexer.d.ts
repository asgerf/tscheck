interface Foo {
	x: string;
}
interface IMap {
	[x:number]: Foo;
}
declare function good(x: IMap, y:number): Foo
declare function bad(x: IMap, y:number): string
