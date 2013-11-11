interface IndexingNumber {
	[x:number] : string;
}
interface IndexingString {
	[x:string] : A;
}
interface A {
	x: number;
}
interface B extends A {
	y: number;
}
