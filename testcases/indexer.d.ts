interface StringMap<T> {
	[s:string]: T;
}

interface NumberMap<T> {
	[n:number]: T;
}

declare var goodstr : StringMap<string>;
declare var badstr : StringMap<string>;

declare var goodnum : NumberMap<string>;
declare var badnum : NumberMap<string>;
