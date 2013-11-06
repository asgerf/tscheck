interface FunA {
    (x:string): string;
}
interface FunA {
    (x:number): number;
}
interface X {
    f: FunA;
}
//interface X {
//    f: FunB;
//}

var x : X = { f: function(x) { return x } }
