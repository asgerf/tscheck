/*
interface Obj {
	f: string,
	g: number
}
declare function good(obj:Obj): string
declare function bad(obj:Obj): string
*/

function good(obj) {
	return obj.f
}
function bad(obj) {
	return obj.g
}
