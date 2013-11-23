declare class Foo {
	foo(x:number);

	base();
}
declare class Bar extends Foo {
	foo(x:number);
	foo(x:string);
}

interface X {
	foo(x:number);
}
interface Y extends X {
	foo(x:number);
	foo(x:string);
}
