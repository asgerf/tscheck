declare class A<T> {
	constructor(x:T);
	public x : T;
}
declare class B extends A<string> {
	public y : number;
}
declare var good : B;
declare var bad : B;
