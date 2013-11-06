declare module A {
    interface I { x: number; }
    interface Gen<T> { x: T; }
}
declare module B {
    import I = A.I;
    function f(): I;
    
    import Ax = A;
    
    import Q = Ax.I;
    function g(): Q;
    
    module C {}
    import D = C;
    
    interface I2 {}
    import I3 = B.I2;
    
    import blah = B.C;
    
    var x : {y: number; new();};
}

interface X<T> { x: T; }
interface X { y: number; }

class C {
    public x: number;
}
