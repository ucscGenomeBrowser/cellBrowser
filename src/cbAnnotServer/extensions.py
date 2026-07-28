"""
Flask extensions instantiated at module level so models.py and route blueprints
can import them without creating a circular import with app.py.

app.py calls `.init_app(app)` on each of these from inside the app factory.
"""
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from flask_mail import Mail

db = SQLAlchemy()
login_manager = LoginManager()
mail = Mail()
