# PyInstaller spec: pyinstaller gridfly.spec  (see build_exe.bat)
a = Analysis(
    ['server.py'],
    datas=[('web', 'web'), ('installer', 'installer')],
    excludes=['tkinter'],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name='GridFly',
    console=True,
    upx=False,
)
